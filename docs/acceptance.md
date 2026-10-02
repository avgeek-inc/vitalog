# Acceptance traceability

This maps the 76 acceptance requirements in the supplied revision-5 [specification](specification.md) to implementation and executable evidence. The [coverage inventory](coverage.json) enumerates every nutrient, analyte and measurement key. The [interoperability report](verification-report.json) records the executed PostgreSQL/REST/MCP run; the [container report](container-report.json) records the packaged deployment run. Test data is synthetic.

`I01`–`I23` below refer to the integration groups in their recorded order, implemented in [scripts/integration.ts](../scripts/integration.ts). `U` refers to [registry/schema tests](../tests/registry.test.ts) and `S` to [summary tests](../tests/summary.test.ts). `C` refers to [the Compose smoke test](../scripts/container-smoke.ts). These references identify software behavior and preserved data semantics; they do not represent medical testing.

| Evidence | Executed contract                                                         |
| -------- | ------------------------------------------------------------------------- |
| I01      | Fresh database, repeatable migrations, empty state and readiness          |
| I02      | Official MCP initialization, sixteen tools, schemas and annotations       |
| I03      | Missing, malformed, invalid and duplicate authorization                   |
| I04      | Host/origin protection and SDK transport methods                          |
| I05      | Catalog parity, empty-state purity, groups, filters and versions          |
| I06      | All 182 nutrients through REST, MCP and correction                        |
| I07      | All 110 measurements through both interfaces and correction               |
| I08      | All 424 analytes through both interfaces and correction                   |
| I09      | Atomic rollback and shared laboratory metadata                            |
| I10      | Concurrent durable cross-interface idempotency                            |
| I11      | Optimistic correction, history, void and original replay                  |
| I12      | Restart, key rotation and a fresh authorized client                       |
| I13      | Daily precedence, estimates, field validity and domain separation         |
| I14      | Sparse trends, assay/unit partitions, undated labs and source status      |
| I15      | Detailed studies, sleep/PAP, strength, check-in, intake and assay context |
| I16      | Nutrient definition partitions and latest usable historical context       |
| I17      | Precise observation ordering, all context partitions and read limits      |
| I18      | Lossless legacy payload, revision and committed-retry retrieval           |
| I19      | Forward migration with populated prior schema                             |
| I20      | Related records, cycles, daily date conflicts, cursors and errors         |
| I21      | Streaming export, real PostgreSQL backup/restore and permanent erasure    |
| I22      | Oversized requests, secret arguments and operational log privacy          |
| I23      | Rate limiting and untrusted forwarded-address rejection                   |

| Requirement                                                | Implementation and evidence                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Service and PostgreSQL only                             | Compose, production image and automatic migrations; C, I01                                                                                          |
| 2. Fail-closed configuration and authorization             | Configuration and HTTP middleware; U, I03, C                                                                                                        |
| 3. Secret privacy and rotation                             | Digest comparison, operational logs, durable database idempotency; I12, I22                                                                         |
| 4. Excluded product objects                                | Closed schemas, sixteen domain routes/tools, no UI or auxiliary product service; U, I02, C                                                          |
| 5. Date-only and local timestamp boundaries                | Event normalization and original time context; U                                                                                                    |
| 6. Atomic batches and returned IDs                         | Transactional store and individual retrieval; I07–I09                                                                                               |
| 7. Same-key concurrency and changed-payload conflict       | Operation/key constraint, canonical hash, transaction lock; I10                                                                                     |
| 8. Lost-response replay after restart/correction           | Immutable committed versions and durable metadata; I11, I12                                                                                         |
| 9. Optimistic correction and current calculations          | Full replacement, expected version and current-record reads; I11, I13                                                                               |
| 10. Sparse unknown/zero/qualified nutrients                | Sparse typed nutrient maps and decimal summaries; U, S, I06, I13                                                                                    |
| 11. Field-by-field whole-day precedence                    | Qualified daily override and labelled intake subtotal; S, I13                                                                                       |
| 12. Unique active daily totals and moved dates             | Store validation and partial unique index; I13, I20                                                                                                 |
| 13. Intake after a reported daily total                    | `daily_total_present` warning, retained records and stable effective total; I13                                                                     |
| 14. Preserved estimates, no estimator                      | Supplied provenance and inherited field overrides; S, I13                                                                                           |
| 15. Separate beverage nutrition and fluid volume           | Independent record domains; total fluid already includes water; S, I13                                                                              |
| 16. Workout/daily energy coverage                          | Separate reported daily totals and active/gross/unknown workout subtotals; S, I13                                                                   |
| 17. Invalid pulse with usable workout                      | Indexed field overrides and per-field exclusion; U, S, I13                                                                                          |
| 18. Sleep wake date, stages and overlap                    | Wake-date normalization; overlapping sessions suppress an exact sum; U, S, I15                                                                      |
| 19. Absence does not imply fasting/completeness            | Null gaps, explicit completeness and actual intake events; S, I13, I14                                                                              |
| 20. No inferred nutrient dose                              | Actual administered amounts and explicitly supplied nutrient contributions; S, I15                                                                  |
| 21. Typed labs and unresolved dates                        | Quantity/bound/interval/coded/absent variants and explicit undated storage; U, I08, I14                                                             |
| 22. Context partitions and sparse trends                   | Full supplied series dimensions, null gaps and contributing counts; I14, I16, I17                                                                   |
| 23. Stable bounded pagination/context                      | Signed filter-bound cursors, fixed-dataset ordering and explicit limits; U, I17, I20                                                                |
| 24. Void versus permanent erasure                          | Immutable revisions; operator truncates records, revisions and retry metadata; I11, I21, README backup policy                                       |
| 25. Bounded inert inputs                                   | Closed schemas, allowlisted parameterized filters and request bounds; U, I20, I22                                                                   |
| 26. MCP contracts and protected discovery                  | Official SDK, strict schemas, structured results and annotations; I02, I03                                                                          |
| 27. Fresh client after restart, no seed                    | Fresh authorized retrieval and empty installation; I01, I12, C                                                                                      |
| 28. Client-independent REST/MCP contract                   | Shared service and registry, integration guide and Postman; I05–I08, I12                                                                            |
| 29. Empty-state code catalog                               | Database-independent overview and lookup; U, I05                                                                                                    |
| 30. All nutrients accepted and unknown fields rejected     | Inventory enumeration, closed map and definition metadata; U, I06, I20                                                                              |
| 31. Complete panel memberships and partial panels          | Shared canonical analyte identity and optional reported members; U, I05, I08                                                                        |
| 32. Exact failures, literal/alias searches                 | Scoped catalog validation and immutable writable identifiers; U, I05                                                                                |
| 33. Complete self-contained record schemas                 | Shared envelopes, local references and atomic wrappers; U, I02, I05                                                                                 |
| 34. Registry/runtime/catalog/interface parity              | One registry and generated OpenAPI/Postman/schema contracts; U, I05–I08, I20                                                                        |
| 35. Complete discovery pages, byte/version bounds          | Signed version-bound cursors and explicit byte-limit failure; U, I05                                                                                |
| 36. Actionable unknown keys and custom fallback            | Bounded issue paths, discovery guidance and strict custom result union; U, I08, I20                                                                 |
| 37. One protected catalog, sixteen tools                   | Bearer middleware and exact tool inventory; U, I02, I03                                                                                             |
| 38. Recognized versus preserved lab units                  | Per-key encoding hints, original unfamiliar units, no lab normalization or clinical range enforcement; U, I14                                       |
| 39. Exact 182/424/110 inventory                            | Unique-key assertions and exhaustive writes/corrections; U, I06–I08                                                                                 |
| 40. Source status, validity and datastore status           | Independent fields preserved through correction; U, I08, I11, I14, I15                                                                              |
| 41. Pending, cancelled, negative, zero and detection bound | Distinct typed result/absence/source-status fields; U, I08, I14                                                                                     |
| 42. Signed and abnormal observations                       | Quantity-aware structural validation, source ranges stored without clinical gating; U, I07, I08                                                     |
| 43. Multiple contextual reference ranges                   | Typed supplied range arrays and no inferred patient attributes; U, I15                                                                              |
| 44. Distinct CBC identities                                | Separate registered keys and original quantity context/units; U, I08                                                                                |
| 45. Spot, ratio and timed urine                            | Separate keys, specimen collection context and effective periods; U, I08, I21                                                                       |
| 46. CO2 and clearance/eGFR distinctions                    | Distinct registry keys, equation/marker/indexing context and series partitions; U, I08, I15                                                         |
| 47. Assay-specific and incompatible units                  | Distinct identities and raw unit/method partitions, no generic conversion; I08, I14                                                                 |
| 48. Titer, pattern, ordinal, interval and complete ratio   | Typed result union with structural checks; U, I08                                                                                                   |
| 49. Microbiology target/isolate/antimicrobial              | Bounded typed microbiology variants without inferred interpretation; U, I08                                                                         |
| 50. Source report versus datastore revision                | Independent `report_revision`, `source_status` and immutable record versions; I11, I15                                                              |
| 51. Unknown legacy nutrient basis                          | Lossless version-one reader/copy and no automatic component reassignment; U, I18, I19                                                               |
| 52. Overlapping carbohydrate components                    | Individually reported nutrient keys and non-additive overlap metadata; S, I06, I13                                                                  |
| 53. One energy representation                              | Decimal kJ/kcal conversion, selection and conflict suppression; S, I13                                                                              |
| 54. Bounds/intervals/zero retain meaning                   | Qualifiers stored distinctly and excluded from exact sums; U, S, I13                                                                                |
| 55. Qualified whole-day precedence                         | Bound/range override with null effective equality; plain null versus zero; S, I13                                                                   |
| 56. Moieties, equivalents and metabolites                  | Distinct nutrient identifiers, bases and non-additive metadata; U, I06, I16                                                                         |
| 57. Combined versus constituent definitions                | Separate keys and component definition metadata; U, S, I06                                                                                          |
| 58. Consumed-total contract                                | Literal quantity-basis validation, no scaling or Daily Value inference; U                                                                           |
| 59. Food water, supplements and fluid routes               | Separate stored domains and route coverage; S, I13, I15                                                                                             |
| 60. Composition method, region/side and frequency          | Typed measurement context and registered component keys; U, I07, I17                                                                                |
| 61. DXA, spirometry and ECG qualifiers                     | Typed method/reference/classification context preserved in data and series identity; U, I07, I15                                                    |
| 62. CGM period/coverage/bands/GMI                          | Source study metadata and irregular interval observations; I07, I15                                                                                 |
| 63. Study projection and duplicate representation          | Stable source/component paths, no extra stored record, overlap warnings; I07, I15, I20                                                              |
| 64. Respiratory indices and supplied denominators          | Typed sleep respiratory/oxygen definitions; U, I15                                                                                                  |
| 65. Historical PAP observations                            | Typed session pressure/use/leak basis and percentile fields; U, I15                                                                                 |
| 66. Workout times, segments, work and energy               | Structural timing checks and nested components excluded from enclosing sums; S, I15                                                                 |
| 67. Strength, exertion and cadence meaning                 | Explicit load interpretation, RPE scale, reserve and cadence unit; U, I15                                                                           |
| 68. Symptom/assessment and supplied reproductive context   | Typed scale versions/bounds, nullable booleans and optional supplied fields; U, I15                                                                 |
| 69. Administration versus package strength                 | Distinct amount, ingredient strength and partial-intake status; I15                                                                                 |
| 70. Every nested field and discriminator discoverable      | Recursive field index and exact indexed schema lookup; U, I05                                                                                       |
| 71. Legacy snapshots and committed retries                 | Versioned opaque legacy read, immutable historical snapshots, explicit current correction and populated forward migration; U, I18, I19              |
| 72. Typed custom analytes with separate identity           | Closed custom branch, preserved custom identity/context and no registry mutation; U, I08                                                            |
| 73. Same narrow application surface                        | One API process/database and sixteen tools; U, I02, C                                                                                               |
| 74. Incompatible nutrient bases                            | Separate labelled subtotals, definition versions and methods, unknown remains unknown; S, I16                                                       |
| 75. Energy concept precedence/conflicts                    | One selected representation, kJ whole-day override and contradictory-value suppression; S, I13                                                      |
| 76. Honest sources and code mappings                       | Supplied source register retained in specification; no unverified external-code crosswalk or universal clinical vocabulary claim; README, inventory |

The version-one evidence uses synthetic legacy payloads and a populated prior database schema. It demonstrates the lossless migration/read/retry mechanism; it is not a claim that an external historical production database was imported. Deployment operators still supply real secrets, ingress host/origin values, TLS, encrypted backup storage and retention choices. The repository includes the runnable application and procedures for those choices, without creating external infrastructure accounts.
