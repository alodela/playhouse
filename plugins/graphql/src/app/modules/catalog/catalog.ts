import { resolvePackagePath } from "@backstage/backend-common";
import { createModule } from "graphql-modules";
import { loadFilesSync } from '@graphql-tools/load-files'
import GraphQLJSON, { GraphQLJSONObject } from "graphql-type-json";
import { ResolverContext } from "../../types";
import { refToId as defaultRefToId } from "../../refToId";

export const Catalog = createModule({
  id: 'catalog',
  typeDefs: loadFilesSync(resolvePackagePath('@frontside/backstage-plugin-graphql', 'src/app/modules/catalog/catalog.graphql')),
  resolvers: {
    Lifecycle: {
      EXPERIMENTAL: 'experimental',
      PRODUCTION: 'production',
      DEPRECATED: 'deprecated',
    },
    JSON: GraphQLJSON,
    JSONObject: GraphQLJSONObject,
    Query: {
      entity: (
        _: any,
        { name, kind, namespace = 'default' }: { name: string; kind: string; namespace: string },
        { refToId = defaultRefToId }: ResolverContext
      ): { id: string } => ({ id: refToId({ name, kind, namespace }) }),
    }
  },
})
