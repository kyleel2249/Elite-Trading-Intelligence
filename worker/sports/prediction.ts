export type Outcome = "H" | "D" | "A";
export interface MatchResult {
  fixtureId?: string;
  competition?: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  playedAt: number;
}
export interface PredictionRow {
  pHome: number;
  pDraw: number;
  pAway: number;
  outcome: Outcome;
}
export interface FootballPrediction {
  modelVersion: string;
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  probabilities: { home: number; draw: number; away: number; over25: number; under25: number; bttsYes: number; bttsNo: number };
  sample: { homeTeamMatches: number; awayTeamMatches: number; leagueMatches: number };
  status: "insufficient_data" | "uncalibrated";
  calibration: { calibrated: false; sampleSize: number; brierScore: null; logLoss: null };
}
const MODEL_VERSION = "eti-poisson-form-v1";
const clean = (v: string) => v.trim().toLocaleLowerCase();
const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
function poisson(lambda: number, max = 10): number[] {
  const p=[Math.exp(-lambda)];
  for(let k=1;k<=max;k++) p.push(p[k-1]*lambda/k);
  const sum=p.reduce((a,b)=>a+b,0);
  return p.map(x=>x/sum);
}
export function estimateFootballMatch(history: MatchResult[], homeTeam: string, awayTeam: string, competition?: string): FootballPrediction {
  const relevant=history.filter(m=>Number.isFinite(m.homeGoals)&&Number.isFinite(m.awayGoals)&&m.homeGoals>=0&&m.awayGoals>=0&&m.homeTeam&&m.awayTeam&&(!competition||!m.competition||clean(m.competition)===clean(competition))).sort((a,b)=>b.playedAt-a.playedAt);
  const home=clean(homeTeam), away=clean(awayTeam);
  const homeMatches=relevant.filter(m=>clean(m.homeTeam)===home||clean(m.awayTeam)===home).slice(0,20);
  const awayMatches=relevant.filter(m=>clean(m.homeTeam)===away||clean(m.awayTeam)===away).slice(0,20);
  const leagueHome=mean(relevant.map(m=>m.homeGoals))||1.35;
  const leagueAway=mean(relevant.map(m=>m.awayGoals))||1.10;
  const homeAtHome=relevant.filter(m=>clean(m.homeTeam)===home).slice(0,15);
  const awayAtAway=relevant.filter(m=>clean(m.awayTeam)===away).slice(0,15);
  const homeScored=homeAtHome.map(m=>m.homeGoals);
  const homeConceded=homeAtHome.map(m=>m.awayGoals);
  const awayScored=awayAtAway.map(m=>m.awayGoals);
  const awayConceded=awayAtAway.map(m=>m.homeGoals);
  const shrink=5;
  const hAttack=(mean(homeScored)*homeScored.length+leagueHome*shrink)/(homeScored.length+shrink)/leagueHome;
  const hDefence=(mean(homeConceded)*homeConceded.length+leagueAway*shrink)/(homeConceded.length+shrink)/leagueAway;
  const aAttack=(mean(awayScored)*awayScored.length+leagueAway*shrink)/(awayScored.length+shrink)/leagueAway;
  const aDefence=(mean(awayConceded)*awayConceded.length+leagueHome*shrink)/(awayConceded.length+shrink)/leagueHome;
  const lambdaHome=Math.max(0.15,Math.min(4.5,leagueHome*hAttack*aDefence));
  const lambdaAway=Math.max(0.15,Math.min(4.5,leagueAway*aAttack*hDefence));
  const ph=poisson(lambdaHome), pa=poisson(lambdaAway);
  let h=0,d=0,a=0,o25=0,btts=0;
  for(let x=0;x<ph.length;x++) for(let y=0;y<pa.length;y++){
    const p=ph[x]*pa[y];
    if(x>y)h+=p; else if(x===y)d+=p; else a+=p;
    if(x+y>2.5)o25+=p;
    if(x>0&&y>0)btts+=p;
  }
  const total=h+d+a||1;
  const enough=homeMatches.length>=5&&awayMatches.length>=5&&relevant.length>=20;
  return {
    modelVersion:MODEL_VERSION,
    expectedHomeGoals:Number(lambdaHome.toFixed(3)),
    expectedAwayGoals:Number(lambdaAway.toFixed(3)),
    probabilities:{home:h/total,draw:d/total,away:a/total,over25:o25,under25:1-o25,bttsYes:btts,bttsNo:1-btts},
    sample:{homeTeamMatches:homeMatches.length,awayTeamMatches:awayMatches.length,leagueMatches:relevant.length},
    status:enough?"uncalibrated":"insufficient_data",
    calibration:{calibrated:false,sampleSize:0,brierScore:null,logLoss:null}
  };
}
export function fitTemperature(rows: PredictionRow[]): {temperature:number;sampleSize:number;brierScore:number|null;logLoss:number|null;calibrated:boolean} {
  if(rows.length<100)return {temperature:1,sampleSize:rows.length,brierScore:null,logLoss:null,calibrated:false};
  const valid=rows.filter(r=>[r.pHome,r.pDraw,r.pAway].every(x=>Number.isFinite(x)&&x>0)&&["H","D","A"].includes(r.outcome));
  if(valid.length<100)return {temperature:1,sampleSize:valid.length,brierScore:null,logLoss:null,calibrated:false};
  const scale=(r:PredictionRow,t:number)=>{const xs=[r.pHome,r.pDraw,r.pAway].map(x=>Math.pow(Math.max(1e-8,x),1/t));const s=xs[0]+xs[1]+xs[2];return xs.map(x=>x/s)};
  let bestT=1,best=Infinity;
  for(let t=0.65;t<=1.8001;t+=0.01){const loss=mean(valid.map(r=>{const p=scale(r,t);const idx=r.outcome==="H"?0:r.outcome==="D"?1:2;return -Math.log(Math.max(1e-9,p[idx]));}));if(loss<best){best=loss;bestT=t;}}
  let brier=0;
  for(const r of valid){const p=scale(r,bestT);const y=[r.outcome==="H"?1:0,r.outcome==="D"?1:0,r.outcome==="A"?1:0];brier+=p.reduce((s,v,i)=>s+(v-y[i])**2,0);}
  brier/=valid.length;
  return {temperature:Number(bestT.toFixed(2)),sampleSize:valid.length,brierScore:Number(brier.toFixed(5)),logLoss:Number(best.toFixed(5)),calibrated:true};
}
export function applyTemperature(probabilities:{home:number;draw:number;away:number},temperature:number) {
  const t=Math.max(0.5,Math.min(2,temperature||1));
  const xs=[probabilities.home,probabilities.draw,probabilities.away].map(x=>Math.pow(Math.max(1e-8,x),1/t));
  const sum=xs[0]+xs[1]+xs[2];
  return {home:xs[0]/sum,draw:xs[1]/sum,away:xs[2]/sum};
}
export function fractionalKellyStake(probability:number,decimalOdds:number,bankrollCents:number,fraction=0.25,cap=0.01):number {
  if(!Number.isFinite(probability)||probability<=0||probability>=1||!Number.isFinite(decimalOdds)||decimalOdds<=1||!Number.isFinite(bankrollCents)||bankrollCents<=0)return 0;
  const b=decimalOdds-1,q=1-probability;
  const full=(b*probability-q)/b;
  if(full<=0)return 0;
  return Math.max(0,Math.min(Math.floor(bankrollCents*cap),Math.floor(bankrollCents*full*fraction)));
}
