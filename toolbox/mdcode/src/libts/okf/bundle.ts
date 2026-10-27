// Where an OKF bundle sits in a workspace.
//
// Beside catalog.yaml, never inside `catalog/`, so the bundle on its own is a
// portable OKF bundle that another consumer can read.

export const BUNDLE_DIR = 'bundle';

// The kcmd-native layouts keep their files here.
export const CATALOG_DIR = 'catalog';
