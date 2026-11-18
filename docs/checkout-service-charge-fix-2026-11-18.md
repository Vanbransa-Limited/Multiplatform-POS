# KES 925 checkout rejection

The reported checkout is ORD-1-939847, billed by Kester. Production reads found a canonical unpaid KES 100 round and a separate held KES 825 round that could not publish. The held round contains pork quarter (KES 400), roasted potatoes (KES 250) and Fanta (KES 100), plus the service-charge and staff-discount options. The till calculates goods 750 + service 225 (30%) - staff discount 150 (20%) = 825. Together the rounds total KES 925.

The rejection occurs while `settleRounds` publishes the unsynced round through `createSale`, before receipt validation. `prepareSaleLines` previously priced the service row using its placeholder catalogue price 100 instead of the computed service 225. Its resulting total 700 could not match the saved 825 credit entry. The previous release fixed charging canonical saved bills but missed publication of these service-charge rounds.

`prepareSaleLines` now derives the service charge as 30% of the authoritative goods subtotal before discounts. It requires one service row with quantity 1 and the service product's trusted service flag. Product tenancy, active status, tax metadata, discount authorization, payment equality, receipt claims and idempotent replay remain enforced. Client-selected prices are not accepted. Existing saved sales replay without repricing.

Regression checks cover publication of the 825 round, its 225 service and 150 staff discount, the 925 two-round claim, one typed receipt across those rounds and repeat settlement without another payment. Additional checks refuse multiple service units and a non-service row disguised as the charge. The real frontend payload formatter was also run against the production-read product metadata; it produced the expected 825 round and 925 checkout without production writes.

176 backend and 230 frontend tests pass. This change only requires deployment of createSale; the frontend build is unchanged. Claude review was requested using the approved anonymized-code workflow, but the account still reports its five-hour usage limit, so no Claude review of this additional fix is claimed. The reported bill has not been marked paid by the investigation; its source till should retry Record payment after deployment.

Production deployment completed successfully. The Firebase CLI independently reports createSale ACTIVE in europe-west1 on Node.js22. Its live endpoint is reachable and still rejects unauthenticated requests. No frontend or catalogue changes were required.
