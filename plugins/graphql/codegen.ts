import { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: 'src/app/schema.ts',
  generates: {
    './src/app/modules/': {
      preset: 'graphql-modules',
      presetConfig: {
        baseTypesPath: '../__generated__/graphql.ts',
        filename: '__generated__/types.ts',
      },
      plugins: [
        { add: { content: '/* eslint-disable */' } },
        'typescript',
        'typescript-resolvers',
      ],
    },
    './__generated__/schema.graphql': {
      plugins: ['schema-ast'],
    },
  },
};

export default config;
