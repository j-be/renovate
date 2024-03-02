import is from '@sindresorhus/is';
import { logger } from '../../../logger';
import { coerceArray } from '../../../util/array';
import { regEx } from '../../../util/regex';
import { trimTrailingSlash } from '../../../util/url';
import { parseYaml } from '../../../util/yaml';
import { DockerDatasource } from '../../datasource/docker';
import { GitTagsDatasource } from '../../datasource/git-tags';
import { HelmDatasource } from '../../datasource/helm';
import { splitImageParts } from '../dockerfile/extract';
import type {
  ExtractConfig,
  PackageDependency,
  PackageFileContent,
} from '../types';
import {
  ApplicationDefinition,
  type ApplicationSource,
  type ApplicationSpec,
} from './schema';
import { fileTestRegex } from './util';

const kustomizeImageRe = regEx(/(.+)=(.+)/);

export function extractPackageFile(
  content: string,
  packageFile: string,
  _config?: ExtractConfig,
): PackageFileContent | null {
  // check for argo reference. API version for the kind attribute is used
  if (fileTestRegex.test(content) === false) {
    logger.debug(
      `Skip file ${packageFile} as no argoproj.io apiVersion could be found in matched file`,
    );
    return null;
  }

  let definitions: ApplicationDefinition[];
  try {
    definitions = parseYaml(content, null, {
      customSchema: ApplicationDefinition,
      failureBehaviour: 'filter',
    });
  } catch (err) {
    logger.debug({ err, packageFile }, 'Failed to parse ArgoCD definition.');
    return null;
  }

  const deps = definitions.flatMap(processAppSpec);

  return deps.length ? { deps } : null;
}

function processSource(source: ApplicationSource): PackageDependency[] {
  // a chart variable is defined this is helm declaration
  if (source.chart) {
    // assume OCI helm chart if repoURL doesn't contain explicit protocol
    if (
      source.repoURL.startsWith('oci://') ||
      !source.repoURL.includes('://')
    ) {
      let registryURL = source.repoURL.replace('oci://', '');
      registryURL = trimTrailingSlash(registryURL);

      return [
        {
          depName: `${registryURL}/${source.chart}`,
          currentValue: source.targetRevision,
          datasource: DockerDatasource.id,
        },
      ];
    }

    return [
      {
        depName: source.chart,
        registryUrls: [source.repoURL],
        currentValue: source.targetRevision,
        datasource: HelmDatasource.id,
      },
    ];
  }

  let dependencies: PackageDependency[] = [
    {
      depName: source.repoURL,
      currentValue: source.targetRevision,
      datasource: GitTagsDatasource.id,
    },
  ];

  // Git repo is pointing to a Kustomize resources
  if (source.kustomize?.images) {
    dependencies = dependencies.concat(
      source.kustomize.images.map(processKustomizeImage).filter(is.truthy),
    );
  }

  return dependencies;
}

function processAppSpec(
  definition: ApplicationDefinition,
): PackageDependency[] {
  const spec: ApplicationSpec =
    definition.kind === 'Application'
      ? definition.spec
      : definition.spec.template.spec;

  let deps: PackageDependency[] = [];

  if (is.nonEmptyObject(spec.source)) {
    deps = processSource(spec.source);
  }

  for (const source of coerceArray(spec.sources)) {
    deps = deps.concat(processSource(source));
  }

  return deps;
}

function processKustomizeImage(image: string): PackageDependency | null {
  if (!kustomizeImageRe.test(image)) {
    return null;
  }

  const parts = kustomizeImageRe.exec(image);
  if (parts?.length !== 3) {
    return null;
  }

  return {
    ...splitImageParts(parts[2]),
    datasource: DockerDatasource.id,
  };
}
