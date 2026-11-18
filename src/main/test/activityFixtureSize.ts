// Windows hosted runners exercise the same query plans with fewer encrypted pages.
export const ACTIVITY_FIXTURE_REQUESTS = process.platform === 'win32' && process.env.CI ? 30_000 : 150_000;
