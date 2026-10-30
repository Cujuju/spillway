/** A credited person or project, shown in Settings → About. `role` says what they contributed. */
export interface Credit {
  name: string;
  url: string;
  role: string;
  /** Where to fund their work, when they take sponsorship. */
  sponsorUrl?: string;
}

/** People who built Spillway, creator first. Add a contributor as one entry. */
export const CONTRIBUTORS: readonly Credit[] = [
  { name: 'Cuju Ju', url: 'https://github.com/Cujuju', role: 'Creator' },
];

/** Projects Spillway builds on. */
export const ACKNOWLEDGEMENTS: readonly Credit[] = [
  { name: 'CLIProxyAPI', url: 'https://github.com/router-for-me/CLIProxyAPI', role: 'The proxy Spillway runs, built from the Cujuju/CLIProxyAPI fork.', sponsorUrl: 'https://github.com/sponsors/router-for-me' },
  { name: 'LobeHub Icons', url: 'https://github.com/lobehub/lobe-icons', role: 'Provider logos (MIT). Brand marks belong to their owners.' },
];
