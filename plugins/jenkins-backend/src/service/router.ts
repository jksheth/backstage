/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { errorHandler } from '@backstage/backend-common';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import { JenkinsInfoProvider } from './jenkinsInfoProvider';
import { JenkinsApiImpl } from './jenkinsApi';
import {
  PermissionAuthorizer,
  PermissionEvaluator,
  toPermissionEvaluator,
} from '@backstage/plugin-permission-common';
import { getBearerTokenFromAuthorizationHeader } from '@backstage/plugin-auth-node';
import { stringifyEntityRef } from '@backstage/catalog-model';

export interface RouterOptions {
  logger: Logger;
  jenkinsInfoProvider: JenkinsInfoProvider;
  permissions?: PermissionEvaluator | PermissionAuthorizer;
}

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { jenkinsInfoProvider, permissions, logger } = options;

  let permissionEvaluator: PermissionEvaluator | undefined;
  if (permissions && 'authorizeConditional' in permissions) {
    permissionEvaluator = permissions as PermissionEvaluator;
  } else {
    logger.warn(
      'PermissionAuthorizer is deprecated. Please use an instance of PermissionEvaluator instead of PermissionAuthorizer in PluginEnvironment#permissions',
    );
    permissionEvaluator = permissions
      ? toPermissionEvaluator(permissions)
      : undefined;
  }

  const jenkinsApi = new JenkinsApiImpl(permissionEvaluator);

  const router = Router();
  router.use(express.json());

  router.get(
    '/v1/entity/:namespace/:kind/:name/projects',
    async (request, response) => {
      const { namespace, kind, name } = request.params;
      const token = getBearerTokenFromAuthorizationHeader(
        request.header('authorization'),
      );
      const branch = request.query.branch;
      let branches: string[] | undefined;

      if (branch === undefined) {
        branches = undefined;
      } else if (typeof branch === 'string') {
        branches = branch.split(/,/g);
      } else {
        // this was passed in as something weird -> 400
        // https://evanhahn.com/gotchas-with-express-query-parsing-and-how-to-avoid-them/
        response
          .status(400)
          .send('Something was unexpected about the branch queryString');

        return;
      }

      const jenkinsInfo = await jenkinsInfoProvider.getInstance({
        entityRef: {
          kind,
          namespace,
          name,
        },
        backstageToken: token,
      });
      const projects = await jenkinsApi.getProjects(jenkinsInfo, branches);

      response.json({
        projects: projects,
      });
    },
  );

  router.get(
    '/v1/entity/:namespace/:kind/:name/job/:jobFullName/:buildNumber',
    async (request, response) => {
      const token = getBearerTokenFromAuthorizationHeader(
        request.header('authorization'),
      );
      const { namespace, kind, name, jobFullName, buildNumber } =
        request.params;

      const jenkinsInfo = await jenkinsInfoProvider.getInstance({
        entityRef: {
          kind,
          namespace,
          name,
        },
        jobFullName,
        backstageToken: token,
      });

      const build = await jenkinsApi.getBuild(
        jenkinsInfo,
        jobFullName,
        parseInt(buildNumber, 10),
      );

      response.json({
        build: build,
      });
    },
  );

  router.post(
    '/v1/entity/:namespace/:kind/:name/job/:jobFullName/:buildNumber::rebuild',
    async (request, response) => {
      const { namespace, kind, name, jobFullName } = request.params;
      const token = getBearerTokenFromAuthorizationHeader(
        request.header('authorization'),
      );
      const jenkinsInfo = await jenkinsInfoProvider.getInstance({
        entityRef: {
          kind,
          namespace,
          name,
        },
        jobFullName,
        backstageToken: token,
      });

      const resourceRef = stringifyEntityRef({ kind, namespace, name });
      await jenkinsApi.buildProject(jenkinsInfo, jobFullName, resourceRef, {
        token,
      });
      response.json({});
    },
  );
  router.use(errorHandler());
  return router;
}
