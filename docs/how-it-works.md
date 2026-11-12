# How it works

OrcaCompass discovers agent models, builds per-axis profiles from the evidence
snapshot, reads usage, and routes to the cheapest cost tier whose evidence
covers the job, then the most headroom. Scores are raw evidence; cost tiers
come from price (3:1 blended input/output, `costBands` default `[1, 5, 12]`),
with hints and evidence class as fallbacks when price is missing.
Recent hand-outs adjust usage before the next route. Run `orcacompass ranking`
for the evidence view, `orcacompass tiers` for cost tiers,
`orcacompass tiers --axis coding` for evidence bands and `orcacompass status`
for usage. See [Tiers and routing](tiers-and-routing.md)
and [Model data](model-data.md) for details.
