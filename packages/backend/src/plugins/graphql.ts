import { createRouter } from '@frontside/backstage-plugin-graphql';
import { Router } from 'express';
import { PluginEnvironment } from '../types';
import { myModule } from '../graphql/my-module';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  return await createRouter({
    logger: env.logger,
    config: env.config,
    modules: [myModule],
  });
}
