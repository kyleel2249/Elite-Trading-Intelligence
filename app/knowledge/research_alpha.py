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
