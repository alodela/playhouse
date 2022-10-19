import type { ResolverContext } from './types';

import { parseEntityRef } from '@backstage/catalog-model';
import {
  getDirective,
  MapperKind,
  SchemaMapper,
} from '@graphql-tools/utils';
import {
  GraphQLField,
  GraphQLFieldConfigMap,
  GraphQLFieldMap,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  isInterfaceType,
} from 'graphql';
import { get } from 'lodash';

const resolveMappers: Array<(
  objectField: GraphQLField<{ id: string }, ResolverContext>,
  interfaceField: GraphQLField<{ id: string }, ResolverContext>,
  schema: GraphQLSchema
) => void> = [
  (objectField, interfaceField, schema) => {
    const field = objectField ?? interfaceField
    const fieldDirective = getDirective(schema, field, 'field')?.[0];
    if (!fieldDirective) return

    const isKeyValuePairs = field.type instanceof GraphQLList
      && field.type.ofType instanceof GraphQLObjectType
      && field.type.ofType.name === 'KeyValuePair'
    objectField.resolve = async ({ id }, _, { loader }) => {
      const entity = await loader.load(id);
      if (!entity) return null;
      const fieldValue = get(entity, fieldDirective.at);
      return isKeyValuePairs && fieldValue ? Object.entries(fieldValue).map(([key, value]) => ({ key, value })) : fieldValue
    };
  },
  (objectField, interfaceField, schema) => {
    const field = objectField ?? interfaceField
    const fieldDirective = getDirective(schema, field, 'relation')?.[0];
    if (!fieldDirective) return

    const isList = field.type instanceof GraphQLList
      || (field.type instanceof GraphQLNonNull && field.type.ofType instanceof GraphQLList)
    objectField.resolve = async ({ id }, _, { loader }) => {
      const entities = (await loader.load(id))
        ?.relations
        ?.filter(({ type, targetRef }) => {
          const { kind } = parseEntityRef(targetRef)
          return (
            type === (fieldDirective.type ?? objectField.name) &&
            (fieldDirective.kind ? kind === fieldDirective.kind : true)
          )
        })
        .map(({ targetRef }) => ({ id: targetRef })) ?? []
      const [entity = null] = entities

      return isList ? entities : entity
    };
  },
]

export const mappers: SchemaMapper = {
  [MapperKind.OBJECT_TYPE]: (objectType, schema) => {
    const interfaces = traverseExtends(objectType, schema)
    const typeConfig = objectType.toConfig()
    const fieldsConfig: GraphQLFieldConfigMap<any, any> = {
      ...interfaces.reduce((fields, interfaceType) => ({
        ...fields,
        ...interfaceType.toConfig().fields
      }), {}),
      ...typeConfig.fields,
    }
    const newObjectType = new GraphQLObjectType({
      ...typeConfig,
      fields: fieldsConfig,
      interfaces,
    })

    const interfaceFields = interfaces.reduce(
      (fields, interfaceType) => ({
        ...fields,
        ...interfaceType.getFields(),
      }),
      {} as GraphQLFieldMap<any, any>,
    );
    Object
      .entries(newObjectType.getFields())
      .forEach(
        ([fieldName, fieldType]) => resolveMappers.forEach(
          mapper => mapper(fieldType, interfaceFields[fieldName], schema)
        )
      );
    return newObjectType;
  },
};

function traverseExtends(type: GraphQLObjectType | GraphQLInterfaceType, schema: GraphQLSchema): GraphQLInterfaceType[] {
  const extendDirective = getDirective(schema, type, 'extend')?.[0];
  const interfaces = [...type.getInterfaces()]
  if (extendDirective) {
    const extendType = schema.getType(extendDirective.type)
    if (!isInterfaceType(extendType)) {
      throw new Error(`The interface "${extendDirective.type}" described in @extend directive for "${type.name}" isn't abstract type or doesn't exist`)
    }

    interfaces.push(...traverseExtends(extendType, schema))
  }
  return isInterfaceType(type) ? [...interfaces, type] : interfaces
}
