import { colorPattern, isPlainObject, isValidExtensionId, normalizeSemver } from './util.js';

// Derive the publish manifest from twext.yml. The registry no longer accepts
// pre-compiled code: the manifest is whatever the project declares so a review
// of the source is a review of the artifact.
export function manifestFromProject(projectConfig, pathId) {
  const errors = [];
  const ext =
    isPlainObject(projectConfig.extension) && typeof projectConfig.extension === 'object'
      ? projectConfig.extension
      : {};

  if (!isValidExtensionId(ext.id) || ext.id !== pathId) {
    errors.push({
      field: 'extension.id',
      message: `Must equal the id in the path ("${pathId}").`,
    });
  }
  if (!normalizeSemver(projectConfig.version)) {
    errors.push({ field: 'version', message: 'Must be a valid SemVer string.' });
  }
  if (
    projectConfig.license !== undefined &&
    (typeof projectConfig.license !== 'string' || projectConfig.license.length === 0)
  ) {
    errors.push({
      field: 'license',
      message: 'License (SPDX identifier) is required when provided.',
    });
  }
  if (projectConfig.description !== undefined && typeof projectConfig.description !== 'string') {
    errors.push({ field: 'description', message: 'Must be a string when provided.' });
  }
  if (
    projectConfig.name !== undefined &&
    (typeof projectConfig.name !== 'string' || projectConfig.name.length === 0)
  ) {
    errors.push({
      field: 'name',
      message: 'Must be a non-empty string when provided.',
    });
  }
  if (projectConfig.author !== undefined && typeof projectConfig.author !== 'string') {
    errors.push({ field: 'author', message: 'Must be a string when provided.' });
  }
  for (const color of ['color1', 'color2', 'color3']) {
    if (
      ext[color] !== undefined &&
      (typeof ext[color] !== 'string' || !colorPattern.test(ext[color]))
    ) {
      errors.push({
        field: `extension.${color}`,
        message: 'Must be "#RRGGBB" when provided.',
      });
    }
  }
  if (errors.length > 0) return { errors, manifest: null };

  const extName = ext.name;
  const name =
    typeof projectConfig.name === 'string' && projectConfig.name.length > 0
      ? projectConfig.name
      : typeof extName === 'string' && extName.length > 0
        ? extName
        : pathId;
  return {
    errors: [],
    // String() keeps every stored field a verified string even if a future
    // edit relaxes a check above; the database columns are TEXT.
    manifest: {
      version: normalizeSemver(projectConfig.version),
      name: String(name),
      license: String(typeof projectConfig.license === 'string' ? projectConfig.license : 'MIT'),
      description: String(
        typeof projectConfig.description === 'string' ? projectConfig.description : '',
      ),
      author: typeof projectConfig.author === 'string' ? projectConfig.author : null,
      color1: typeof ext.color1 === 'string' ? ext.color1 : null,
      color2: typeof ext.color2 === 'string' ? ext.color2 : null,
      color3: typeof ext.color3 === 'string' ? ext.color3 : null,
    },
  };
}
