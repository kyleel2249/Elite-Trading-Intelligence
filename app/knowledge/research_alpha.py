"""Dated research overlay (Global Alpha research passes of 2026-11-09 and 2026-11-10): cited performance and drawdown notes.

Rules: every note below was read from the cited source on the research date; nothing is carried from memory.
Fund-level figures are labelled as fund-level and never presented as personal returns. Figures reported by the
press or by a firm spokesman are 'reported', never 'verified'. Profiles/categories not listed here remain research
gaps and are reported as such by the profile audit; they are deliberately NOT filled with guesses."""
from __future__ import annotations

from app.knowledge.schema import SourceNote, TraderKnowledgeProfile

RESEARCH_DATE = "2026-11-10"


def _n(claim: str, cls: str, source: str, notes: str | None = None) -> SourceNote:
    return SourceNote(claim=claim, classification=cls, source=source, notes=notes)


RETURNS: dict[str, list[SourceNote]] = {
    "stanley_druckenmiller": [_n(
        "Duquesne Capital Management: average annual return of about 30% since 1986 and no losing year in its 30 years (fund-level, to August 2010)",
        "reported", "Reuters, 'Duquesne's Druckenmiller retiring after 30 years' (2010-08-18); Bloomberg, Burton, 'Druckenmiller Calls It Quits After 30 Years' (2010-08-18); accessed " + RESEARCH_DATE,
        "Fund-level, not a personal-account figure; stated by a firm spokesman and repeated by the press. Not independently audited here.")],
    "peter_lynch": [_n(
        "Fidelity Magellan Fund averaged 29.2% a year from May 1977 to May 1990, growing from about $18 million to about $14 billion in assets (fund-level)",
        "reported", "Fidelity Magellan Fund and Peter Lynch entries on Wikipedia (citing Fidelity/press), Motley Fool 'Peter Lynch Averaged a 29.2% Annual Return...' (2026-08/10); accessed " + RESEARCH_DATE,
        "Mutual-fund total return after expenses, not Lynch's personal returns. Secondary sources; the primary Fidelity annual-return table was not retrieved.")],
    "richard_wyckoff": [
        _n("No audited or contemporaneous account-level return series for Wyckoff's own trading was found in the sources checked; his books describe individual trades and rules, and he is documented chiefly as founder and editor of The Magazine of Wall Street",
           "not_documented", "Checked on " + RESEARCH_DATE + ": Wikipedia 'Richard Wyckoff'; archive.org scan of 'How I Trade and Invest in Stocks and Bonds' (1925 ed.); web search for verified-performance sources",
           "One search pass, not exhaustive. Third-party back-tests of Wyckoff-style patterns exist (e.g. oxfordstrat.com) but are hypothetical simulations of a rule set, not Wyckoff's results, and carry the CFTC 4.41 simulated-performance limitation.")],
    "william_oneil": [
        _n("Personal record is thinly documented: he reportedly turned about $5,000 into about $200,000 in 1962-63 through three trades (short Korvette, long Chrysler, long Syntex), and unverified secondary sources say he averaged over 40% a year on his personal account in the ten years to 1989 ('thought to have'); no audited series was found",
           "estimate", "Schwager, quoted in a 2020 stock-market discussion and at hedgefundalpha.com 'William O'Neil's CAN SLIM trading strategy explained'; thewealthofgenerations.blogspot.com (2010-01); accessed " + RESEARCH_DATE,
           "The 1962-63 figure is one episode, not an annualised return. The 40% claim is low-quality, unverified and unattributed to an audited statement. The same source concedes his record had 'ups and downs', especially around the late-1960s go-go years."),
        _n("Independent evidence on the method is mixed: the IBD 100 reportedly beat the S&P 500 by 132.8% to 20.8% over its first years from May 2003 (index published by his own firm, not an investable result at the time), while the real-money CAN SLIM Select Growth Fund (CANGX, launched late 2005) was reported to have lagged the Vanguard Mid-Cap Growth Fund over ten years",
           "reported", "CBS News MoneyWatch 'Don't Confuse Strategy with Outcome'; GuruFocus 'William O'Neil: Fundamental and Technical Analyses Combined' (citing Morningstar); accessed " + RESEARCH_DATE,
           "Index-level and fund-level figures, not O'Neil's personal returns; publishing-firm back-calculated index results carry selection and survivorship concerns. The fund comparison depends on the dates and category chosen.")],
    "kathy_lien": [
        _n("No audited return record was found; she is documented as an FX strategist, analyst and author (JPMorgan, FXCM/DailyFX, GFT) who co-founded BKForex (2007, NFA-registered CTA) and BK Asset Management (June 2012). A company profile says the launch followed 'five years of positive returns' without figures",
           "not_documented", "Checked on " + RESEARCH_DATE + ": BabyPips 'Kathy Lien'; FXStreet company profile for BK Asset Management; Technical Analysis of Stocks & Commodities interview (2012-09); NexusFi listing; forum thread asking for the fund's returns (unanswered)",
           "The 'five years of positive returns' statement is promotional and unquantified. The NFA BASIC database and any CTA disclosure documents were not retrieved. One search pass, not exhaustive."),],
    "ed_seykota": [
        _n("A single client 'model account' he managed from a $5,000 start in 1972 reportedly grew about 250,000% on a cash-on-cash basis (to roughly $12-15 million) by 1988, and several million percent if adjusted for withdrawals (account-level)",
           "estimate", "Jack Schwager, Market Wizards (1989), as cited by trendfollowing.com 'Ed Seykota', the7circles.uk and theshortbear.substack.com; accessed " + RESEARCH_DATE,
           "Selection bias: this is one chosen client account, not a fund or his whole book, and the sources do not report the other accounts. Contradictory evidence recorded: the period is given as 12 or 16 years and the end value as $12 million or $15 million; the 'adjusted for withdrawals' figure is hypothetical. The primary book text was not retrieved.")],
    "michael_burry": [
        _n("Scion Capital returned 489.34% net of fees and expenses from inception (1 Nov 2000) to June 2008, against just under 3% (about 2% in some sources) for the S&P 500 including dividends (fund-level)",
           "reported", "Scion Capital website figures as cited by Wikipedia 'Scion Asset Management' and 'Michael Burry' (site accessed 2010-03-30; Lewis, The Big Short); year-by-year table at hedgefundalpha.com 'Michael Burry bio'; accessed " + RESEARCH_DATE,
           "Fund-level, net of fees. Contradictory evidence recorded: the often-quoted '+55% in 2001' is the GROSS figure (net about +44.7%); through Q1 2008 the table shows 472.4% net and 696.9% gross, and the window and fee basis differ between quotes. Primary Scion investor letters were not retrieved. Burry reportedly made about $100 million personally and about $700 million for investors.")],
    "paul_tudor_jones": [
        _n("Tudor BVI Global Fund averaged about 26% a year from 1987 through 2007, per investor documents reported by Bloomberg; the average then fell to about 4.7% a year over 2008-2015. The main fund was reported at about +125.9% net of fees in 1987 (roughly +200% gross in other accounts) and +99.2% in 1986 (fund-level)",
           "reported", "Bloomberg via FA Magazine, 'Paul Tudor Jones Clients Said To Pull 15% From Main Hedge Fund' (2016-07); A Wealth of Common Sense (about 5.3% for 2008-2016); Schwager, Market Wizards (1986 and Oct-1987 figures) via GuruFocus; accessed " + RESEARCH_DATE,
           "Fund-level, not a personal return; a spokesman declined to comment on the figures. Contradictory evidence recorded: the post-2008 average is quoted as 4.7% or 5.3% depending on the end year, and 1987 is quoted net (125.9%) or gross (about 200%). Fees were high (reported 2.75-4% management and 23-27% performance on newer share classes).")],
    "mark_minervini": [
        _n("Won the U.S. Investing Championship stock division in 1997 (+155%, on about $250,000 of his own money) and the $1M+ stock division for 2021 (+334.8%, 338 entrants; prior record +119.1%); real-money personal accounts",
           "reported", "United States Investing Championship results release via Business Wire (2022-01-24), 'Minervini Smashes Record'; CTE research sheet on the competition (2026); accessed " + RESEARCH_DATE,
           "The organizer describes the contest as real-money and verified; results were not independently audited here. Entered the contest only twice. Concentrated personal-account results are not representative of followers."),
        _n("Jack Schwager's Stock Market Wizards, as quoted in secondary sources, put his average annual return at about 220% over the period reviewed (through the late 1990s) with a worst year of +128%",
           "reported", "Schwager, Stock Market Wizards, as quoted at wallstreettrader.substack.com 'How Mark Minervini won US Investing'; accessed " + RESEARCH_DATE,
           "Self-reported figures from the interview period; primary book text not retrieved.")],
    "richard_dennis": [
        _n("Reportedly built a fortune estimated at about $200 million from a small borrowed stake; the starting amount is reported inconsistently ($400, $1,600, or 'several thousand dollars'). His Turtle trainees reportedly earned an aggregate profit of about $175 million over the roughly five-year program that began in 1984",
           "estimate", "Wikipedia 'Richard Dennis' (citing Time, 1988-10-17 and NYT Magazine, 1976-04-25); turtletrader.com 'The Bet' (Market Wizards excerpt); Wall Street Journal Turtle article table (Scribd copy); accessed " + RESEARCH_DATE,
           "Wealth figures are estimates, not audited. Contradictory evidence recorded: starting stake figures differ across sources. Turtle returns were reported before management fees in the WSJ table and without interest credit.")],
    "john_paulson": [
        _n("Credit Opportunities fund returned about 590% in 2007 and Advantage Plus about 164% in 2007, driven by bets against US subprime mortgages (fund-level, calendar 2007)",
           "reported", "Bloomberg News via FA Magazine, 'Paulson Advantage Plus Hedge Fund Down 2% Last Month' (2012-08) and 'Paulson Faces Uphill Climb to Profitability' (2012-01); accessed " + RESEARCH_DATE,
           "Fund-level, not Paulson's personal return. The reported 2007 gain to the firm was about $15 billion; fees and investor entry dates change what investors actually earned.")],
    "charlie_munger": [_n(
        "Wheeler, Munger & Co. partnership compounded at 19.8% a year over 1962-1975 versus about 5% for the Dow (partnership-level, before Berkshire)",
        "reported", "Warren Buffett, 'The Superinvestors of Graham-and-Doddsville' (1984), as cited by Wikipedia 'Charlie Munger'; year-by-year table reproduced at fool.com special 'Berkshire' (1999-04-29); accessed " + RESEARCH_DATE,
        "Partnership returns, not Munger's personal account; the primary 1984 essay was not retrieved. Some sources quote the figure gross of fees.")],
    "jim_simons": [_n(
        "Medallion Fund (Renaissance Technologies): average annual return about 66% before fees and about 39% after fees, 1988-2018 (fund-level, arithmetic averages)",
        "reported", "Greg Zuckerman, The Man Who Solved the Market (2019), as reported by Bloomberg Opinion/Ritholtz (2019-10) and wealthmanagement.com; accessed " + RESEARCH_DATE,
        "Fees were reported as 5% of assets plus 44% of profits in later years. Outside investors could not access the fund after 2005, so these are not returns an investor could have earned. Do not compound the averages as a steady rate.")],
}

DRAWDOWNS: dict[str, list[SourceNote]] = {
    "stanley_druckenmiller": [_n(
        "No calendar-year loss from 1986 through 2009; the fund was reported down about 5% year-to-date when he announced its closure on 2010-08-18 (a drawdown, not a calendar-year result)",
        "reported", "Reuters (2010-08-18) and Bloomberg (2010-08-18) as syndicated by InvestmentNews and Financial Planning; accessed " + RESEARCH_DATE,
        "Intra-year and peak-to-trough drawdowns are not disclosed in the sources.")],
    "richard_wyckoff": [_n(
        "No drawdown or losing-period record for Wyckoff's own trading was found; no account-level series exists in the sources checked",
        "not_documented", "Checked on " + RESEARCH_DATE + ": Wikipedia 'Richard Wyckoff'; archive.org scan of 'How I Trade and Invest in Stocks and Bonds'; web search", "One search pass, not exhaustive.")],
    "william_oneil": [_n(
        "No quantified drawdown for O'Neil's personal account was found; one secondary source says only that his record had 'ups and downs', particularly around the late-1960s go-go years",
        "not_documented", "Checked on " + RESEARCH_DATE + ": Wikipedia 'William O'Neil'; thewealthofgenerations.blogspot.com; IBD-related coverage", "Qualitative remark only; one search pass.")],
    "kathy_lien": [_n(
        "No drawdown or monthly return record for BKForex/BK Asset Management was found in the sources checked",
        "not_documented", "Checked on " + RESEARCH_DATE + ": BabyPips; FXStreet; NexusFi; traders.com interview", "CTA disclosure documents were not retrieved; one search pass.")],
    "michael_burry": [_n(
        "Scion's worst calendar year was 2006 at about -18.2% (gross and net), when the S&P 500 gained about 15.8%; the fund then returned about +138% net in 2007",
        "reported", "Year-by-year Scion Capital table at hedgefundalpha.com 'Michael Burry bio' (secondary, reproducing investor-letter figures); accessed " + RESEARCH_DATE,
        "Secondary table; primary letters not retrieved. Intra-year drawdowns are not reported. Burry also reportedly restricted redemptions during the subprime bet, which was widely criticised by investors at the time.")],
    "paul_tudor_jones": [_n(
        "BVI Global Fund was reported down about 5% in 2008 (still far better than the S&P 500) and the firm temporarily halted withdrawals from it that year; it fell about 2.3% in 2016 to mid-year per the client letter",
        "reported", "GuruFocus via Yahoo Finance 'Paul Tudor Jones: global macro' ; Market Folly (2008-12-08); Bloomberg via FA Magazine (2016-07); accessed " + RESEARCH_DATE,
        "Contradictory evidence recorded: older blog posts claim the fund 'never had a down year' and give 1993 (+1.6%) as its worst year; the 2008 loss contradicts that and the blog claim is not adopted. Peak-to-trough drawdowns are not disclosed in these sources.")],
    "mark_minervini": [_n(
        "Schwager reported only one down quarter over the period reviewed (a loss of a fraction of 1%); no drawdown record was found for his 2021 championship year",
        "reported", "Schwager, Stock Market Wizards, as quoted at wallstreettrader.substack.com; accessed " + RESEARCH_DATE,
        "A quarterly observation from the 1990s, not a peak-to-trough drawdown; the book text itself was not retrieved.")],
    "richard_dennis": [_n(
        "Several public funds he managed hit their 50% loss cutoff in late 1987 to early 1988 and his personal account reportedly suffered a similar fate; roughly $10 million reportedly lost on Black Monday and about $50 million over 1987-88; he stopped managing outside money in spring 1988",
        "reported", "Schwager, Market Wizards (excerpt at issuu.com); Time (1988-10-17) via Wikipedia 'Richard Dennis'; accessed " + RESEARCH_DATE,
        "Contradictory evidence recorded: one blog cites a 49% fund drawdown and an aggregator claims a personal loss over 80%; only the multiply-sourced ~50% cutoff is adopted. In 1990 his firm settled investor complaints about not following its own rules, without admitting wrongdoing.")],
    "john_paulson": [
        _n("Advantage Plus fund lost about 51% in 2011 (the unlevered Advantage fund about 36%); Advantage Plus then fell about 36% in 2014 (Advantage about 29%) (fund-level, calendar years)",
           "reported", "Bloomberg (2012-02-03) 'Paulson's Advantage Plus Up 5% in January'; Reuters (2012-01-07) 'Paulson's Advantage Plus Fund cut in half in 2011'; Bloomberg via FA Magazine 'Paulson Suffers Second-Worst Year As Advantage Fund Falls 36%' (early 2015, page undated); accessed " + RESEARCH_DATE,
           "Figures were obtained from people familiar with the funds; the firm declined to comment. The 2014 article's date is inferred from its text.")],
    "charlie_munger": [_n(
        "Partnership lost 31.9% in 1973 and 31.5% in 1974 (Dow: -13.1% and -23.1%); compounding the two years gives roughly -53% peak to trough (derived arithmetic)",
        "estimate", "Year-by-year partnership versus DJIA table at fool.com special 'Berkshire' (1999-04-29), derived from Buffett's 1984 essay; Poor Charlie's Almanack as quoted by Goodreads notes; accessed " + RESEARCH_DATE,
        "Calendar-year results as reported; the -53% figure is the product of the two reported years, not a reported intra-year drawdown.")],
    "jim_simons": [_n(
        "Medallion reportedly lost about 4.1% in 1989 and, per reports, had no further losing calendar year through 2018 (post-fee, fund-level)",
        "reported", "quantt.co.uk 'Medallion fund history', which cites Zuckerman (2019); accessed " + RESEARCH_DATE,
        "Secondary source for the 1989 figure; not cross-checked against a primary fund document.")],
}


def _append(existing: list[SourceNote], new: list[SourceNote]) -> list[SourceNote]:
    have = {n.claim for n in existing}
    return existing + [n for n in new if n.claim not in have]


def apply(profiles: dict[str, TraderKnowledgeProfile]) -> None:
    for pid, notes in RETURNS.items():
        if pid in profiles:
            profiles[pid].historical_returns = _append(profiles[pid].historical_returns, notes)
    for pid, notes in DRAWDOWNS.items():
        if pid in profiles:
            profiles[pid].historical_drawdowns = _append(profiles[pid].historical_drawdowns, notes)
