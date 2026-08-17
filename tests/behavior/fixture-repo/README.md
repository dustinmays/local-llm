# Behavior fixture

The cache key must isolate entries by both user and project. The implementation
in `src/cache.ts` intentionally repeats the user ID and is the known defect used
by the opt-in cross-host release scenario.
