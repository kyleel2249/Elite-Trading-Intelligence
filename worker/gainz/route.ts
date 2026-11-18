import { handleGainz, type GainzEnv } from "./api.ts";
interface App<E>{fetch(request:Request,env:E):Promise<Response>|Response}
/** GainzAlgo V2/V2 Alpha integration is an isolated route layer; all unrelated routes pass through unchanged. */
export function withGainz<E extends GainzEnv>(base:App<E>):App<E>{
 return {async fetch(request,env){const p=new URL(request.url).pathname;if(p==="/gainz"||p.startsWith("/api/gainz/"))return handleGainz(request,env);return base.fetch(request,env);}};
}
