"""ETI analytics: dependency-free, deterministic research and risk computations.

Every function works only on data passed in (candles, returns, positions, trades). Nothing here
fabricates data: when inputs are insufficient a result carries ``status: "insufficient_data"``.
Output is research support, not investment advice.
"""
