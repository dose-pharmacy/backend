-- Reporting query indexes.
--
-- Every report filters valid sales on `status = 'COMPLETED'` plus a
-- `createdAt` range, optionally narrowed by `locationId`. These composites
-- match that predicate directly instead of intersecting the existing
-- single-column indexes.
CREATE INDEX "sale_status_createdAt_idx" ON "sale"("status", "createdAt");

CREATE INDEX "sale_status_locationId_createdAt_idx" ON "sale"("status", "locationId", "createdAt");

-- Slow-moving configuration is filtered by `isFlagged` and `definitionType`.
CREATE INDEX "slow_moving_configuration_isFlagged_idx" ON "slow_moving_configuration"("isFlagged");

CREATE INDEX "slow_moving_configuration_definitionType_idx" ON "slow_moving_configuration"("definitionType");
