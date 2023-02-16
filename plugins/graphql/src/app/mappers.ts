import { get, isEqual } from 'lodash';
import { connectionFromArray } from 'graphql-relay';
import { CompoundEntityRef, Entity, parseEntityRef } from '@backstage/catalog-model';
import { getDirective, MapperKind, addTypes, mapSchema, getImplementingTypes } from '@graphql-tools/utils';
import {
  GraphQLFieldConfig,
  GraphQLFieldConfigMap,
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  GraphQLString,
  GraphQLTypeResolver,
  GraphQLUnionType,
  isInputType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isUnionType,
} from 'graphql';
import type { Logger, ResolverContext } from './types';
import { refToId as defaultRefToId } from './refToId';

function getObjectTypeName(iface: GraphQLInterfaceType, directive?: Record<string, any>): string {
  if (directive && 'generatedTypeName' in directive) return directive.generatedTypeName

  return iface.name.slice(1)
}

function filterEntityRefs(entity: Entity | undefined, relationType?: string, targetKind?: string): CompoundEntityRef[] {
  return entity
    ?.relations
    ?.filter(({ type }) => !relationType || type === relationType)
    .flatMap(({ targetRef }) => {
      const ref = parseEntityRef(targetRef)
      return !targetKind || ref.kind.toLowerCase() === targetKind.toLowerCase() ? [ref] : []
    }) ?? []
}

function isConnectionType(type: unknown): type is GraphQLInterfaceType {
  return isInterfaceType(type) && type.name === 'Connection'
  || isNonNullType(type) && isConnectionType(type.ofType);
}

function createConnectionType(
  typeName: string,
  fieldType: GraphQLInterfaceType,
  nodeType: GraphQLOutputType,
): GraphQLObjectType {
  const wrappedEdgeType = fieldType.getFields().edges.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInterfaceType>>>
  const edgeType = wrappedEdgeType.ofType.ofType.ofType as GraphQLInterfaceType

  return new GraphQLObjectType({
    name: `${typeName}Connection`,
    fields: {
      ...fieldType.toConfig().fields,
      edges: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(new GraphQLObjectType({
          name: `${typeName}Edge`,
          fields: {
            ...edgeType.toConfig().fields,
            node: {
              type: new GraphQLNonNull(nodeType as GraphQLOutputType),
            }
          },
          interfaces: [edgeType]
        }))))
      }
    },
    interfaces: [fieldType]
  })
}

export function transformDirectives(
  sourceSchema: GraphQLSchema,
  { logger = console }: { logger?: Logger } = {},
) {
  const inheritsWithoutArgs = new Set<string>();
  const resolversMap: Record<string, GraphQLTypeResolver<any, any>> = {}
  const typesToAdd = new Map<string, GraphQLNamedType>()
  const additionalInterfaces: Record<string, Set<GraphQLInterfaceType>> = {};

  function handleFieldDirective(
    field: GraphQLFieldConfig<{ id: string }, ResolverContext>,
    directive: Record<string, any>
  ) {
    if (
      'at' in directive
      && typeof directive.at !== 'string'
      && (!Array.isArray(directive.at) || directive.at.some(a => typeof a !== 'string'))
    ) {
      throw new Error(`The "at" argument of @field directive must be a string or an array of strings`);
    }
    field.resolve = async ({ id }, _, { loader }) => {
      const entity = await loader.load(id);
      if (!entity) return null;
      return get(entity, directive.at) ?? directive.default;
    };
  }

  function handleRelationDirective(
    field: GraphQLFieldConfig<{ id: string }, ResolverContext>,
    directive: Record<string, any>,
    schema: GraphQLSchema
  ) {
    const fieldType = field.type;
    if (
      isListType(fieldType) && isConnectionType(fieldType.ofType)
      || isNonNullType(fieldType) && isListType(fieldType.ofType) && isConnectionType(fieldType.ofType.ofType)
      ) {
        throw new Error(`It's not possible to use a list of Connection type. Use either Connection type or list of specific type`)
      }
    const isList = isListType(fieldType) || (isNonNullType(fieldType) && isListType(fieldType.ofType))

    if (isConnectionType(fieldType)) {
      if (directive.nodeType) {
        const nodeType = schema.getType(directive.nodeType)

        if (!nodeType) {
          throw new Error(`The interface "${directive.nodeType}" is not defined in the schema.`)
        }
        if (isInputType(nodeType)) {
          throw new Error(`The interface "${directive.nodeType}" is an input type and can't be used in a Connection.`)
        }
        if (isUnionType(nodeType)) {
          const resolveType = nodeType.resolveType;
          if (resolveType)
            logger.warn(
              `The "resolveType" function has already been implemented for "${nodeType.name}" union which may lead to undefined behavior`,
            );
          const iface = (typesToAdd.get(directive.nodeType) ?? new GraphQLInterfaceType({
            name: directive.nodeType,
            interfaces: [schema.getType('Node') as GraphQLInterfaceType],
            fields: { id: { type: new GraphQLNonNull(GraphQLID) } },
            resolveType: (...args) => resolveType?.(...args) ?? resolversMap.Node(...args),
          })) as GraphQLInterfaceType
          typesToAdd.set(directive.nodeType, iface)
          nodeType.getTypes().forEach(type => {
            additionalInterfaces[type.name] = (additionalInterfaces[type.name] ?? new Set()).add(iface)
          })
          field.type = createConnectionType(nodeType.name, fieldType, iface)
        } else {
          const typeName = isInterfaceType(nodeType) ? getObjectTypeName(nodeType) : nodeType.name
          field.type = createConnectionType(typeName, fieldType, nodeType)
        }
      }
      const mandatoryArgs: [string, string][] = [
        ['first', 'Int'],
        ['after', 'String'],
        ['last', 'Int'],
        ['before', 'String'],
      ]

      const args = { ...field.args }
      mandatoryArgs.forEach(([name, type]) => {
        if (name in args) {
          const argType = args[name].type
          if ((isNonNullType(argType) ? argType.ofType.toString() : argType.name) !== type) {
            throw new Error(`The field has mandatory argument "${name}" with different type than expected. Expected: ${type}`)
          }
        }
        args[name] = { type: type === 'Int' ? GraphQLInt : GraphQLString }
      })
      field.args = args

      field.resolve = async ({ id }, args, { loader, refToId = defaultRefToId }) => {
        const ids = filterEntityRefs(await loader.load(id), directive.name, directive.kind)
          .map(ref => ({ id: refToId(ref) }));
        return {
          ...connectionFromArray(ids, args),
          count: ids.length,
        };
      };
    } else {
      field.resolve = async ({ id }, _, { loader, refToId = defaultRefToId }) => {
        const ids = filterEntityRefs(await loader.load(id), directive.name, directive.kind)
          .map(ref => ({ id: refToId(ref) }));
        return isList ? ids : ids[0] ?? null;
      }
    }
  }

  function validateExtendDirective(
    interfaceType: GraphQLInterfaceType,
    directive: Record<string, any>,
    schema: GraphQLSchema,
  ) {
    if (!/^I[A-Z].*/.test(interfaceType.name)) {
      if (!('generatedTypeName' in directive)) {
        throw new Error(
          `The interface name "${interfaceType.name}" should started from capitalized 'I', like: "I${interfaceType.name}"`,
        );
      }
      if (schema.getType(directive.generatedTypeName)) {
        throw new Error(
          `The type "${directive.generatedTypeName}" described in the @inherit directive is already declared in the schema`,
        );
      }
    }
    if ('when' in directive !== 'is' in directive) {
      throw new Error(
        `The @inherit directive for "${interfaceType.name}" should have both "when" and "is" arguments or none of them`,
      );
    }
    if (!('when' in directive)) {
      if (
        'interface' in directive &&
        inheritsWithoutArgs.has(directive.interface)
      ) {
        throw new Error(
          `The @inherit directive of "${directive.interface}" without "when" and "is" arguments could be used only once`,
        );
      } else {
        inheritsWithoutArgs.add(directive.interface);
      }
      const parentType = schema.getType(directive.interface);
      if (parentType) {
        const [inheritDirective] =
          getDirective(schema, parentType, 'inherit') ?? [];
        if (
          inheritDirective &&
          'interface' in inheritDirective &&
          !('when' in inheritDirective) &&
          Object.values(interfaceType.getFields()).some(field =>
            isNonNullType(field.type),
          )
        ) {
          throw new Error(
            `The interface "${interfaceType.name}" has required fields and can't be inherited from "${directive.interface}" without "when" and "is" arguments, because "${directive.interface}" has already been inherited without them`,
          );
        }
      }
    }
    if (
      'when' in directive &&
      (typeof directive.when !== 'string' ||
        (Array.isArray(directive.when) &&
          directive.when.some(a => typeof a !== 'string')))
    ) {
      throw new Error(
        `The "when" argument of @inherit directive must be a string or an array of strings`,
      );
    }
  }

  function defineResolver(iface: GraphQLInterfaceType, directive: Record<string, any>, schema: GraphQLSchema) {
    const objectType = getObjectTypeName(iface, directive);
    if (!resolversMap[iface.name]) resolversMap[iface.name] = () => objectType;

    const inheritedInterface = schema.getType(directive.interface) as
      | GraphQLInterfaceType
      | undefined;
    if (!inheritedInterface) return;

    const [inheritDirective] =
      getDirective(schema, inheritedInterface, 'inherit') ?? [];
    const inheritedObjectType = getObjectTypeName(
      inheritedInterface,
      inheritDirective,
    );
    const resolveType =
      resolversMap[inheritedInterface.name] ??
      (inheritedInterface.name === 'Node'
        ? () => undefined
        : () => inheritedObjectType);
    resolversMap[inheritedInterface.name] = async (
      source: { id: string },
      context: ResolverContext,
      info,
      abstractType,
    ) => {
      if ('when' in directive && 'is' in directive) {
        const { id } = source;
        const { loader } = context;
        const entity = await loader.load(id);
        if (!entity) return undefined;
        if (isEqual(get(entity, directive.when), directive.is)) {
          return (
            resolversMap[iface.name]?.(source, context, info, abstractType) ??
            undefined
          );
        }
        return resolveType(source, context, info, abstractType) ?? undefined;
      }
      return (
        resolversMap[iface.name]?.(source, context, info, abstractType) ??
        undefined
      );
    };
  }

  function mapCompositeField(
    fieldConfig: GraphQLFieldConfig<any, any>,
    fieldName: string,
    typeName: string,
    schema: GraphQLSchema,
  ) {
    const [fieldDirective] = getDirective(schema, fieldConfig, 'field') ?? [];
    const [relationDirective] =
      getDirective(schema, fieldConfig, 'relation') ?? [];

    if (fieldDirective && relationDirective) {
      throw new Error(
        `The field "${fieldName}" of "${typeName}" type has both @field and @relation directives at the same time`,
      );
    }

    try {
      if (fieldDirective) {
        handleFieldDirective(fieldConfig, fieldDirective);
      } else if (relationDirective) {
        handleRelationDirective(fieldConfig, relationDirective, schema);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : error;
      throw new Error(
        `Error while processing directives on field "${fieldName}" of "${typeName}":\n${errorMessage}`,
      );
    }
    return fieldConfig;
  }

  function mapInterfaceType(
    interfaceType: GraphQLInterfaceType,
    schema: GraphQLSchema,
  ) {
    const [inheritDirective] =
      getDirective(schema, interfaceType, 'inherit') ?? [];
    if (!inheritDirective) return interfaceType;

    validateExtendDirective(interfaceType, inheritDirective, schema);
    defineResolver(interfaceType, inheritDirective, schema);

    const objectType = getObjectTypeName(interfaceType, inheritDirective);
    const inheritedInterfaces = traverseExtends(interfaceType, schema);
    const interfaces = [
      ...new Map(
        [
          ...(additionalInterfaces[interfaceType.name]?.values() ?? []),
          ...inheritedInterfaces.flatMap(iface => [
            ...(additionalInterfaces[iface.name]?.values() ?? []),
          ]),
          ...inheritedInterfaces,
        ].map(iface => [iface.name, iface]),
      ).values(),
    ];
    const fields = [...interfaces]
      .reverse()
      .reduce(
        (acc, type) => ({ ...acc, ...type.toConfig().fields }),
        {} as GraphQLFieldConfigMap<any, any>,
      );

    const { astNode, extensionASTNodes, ...typeConfig } =
      interfaceType.toConfig();
    typeConfig.fields = fields;

    typesToAdd.set(
      objectType,
      new GraphQLObjectType({
        ...typeConfig,
        name: objectType,
        interfaces,
      }),
    );

    return new GraphQLInterfaceType({
      ...typeConfig,
      resolveType: (...args) => resolversMap[interfaceType.name](...args),
      interfaces: interfaces.filter(iface => iface.name !== interfaceType.name),
    });
  }

  function mapUnionType(unionType: GraphQLUnionType, schema: GraphQLSchema) {
    const typeConfig = unionType.toConfig();
    let hasInterfacesFromResolversMap = false;

    typeConfig.types = typeConfig.types.flatMap(type => {
      if (
        isInterfaceType(type) &&
        (type as GraphQLInterfaceType).name in resolversMap
      ) {
        hasInterfacesFromResolversMap = true;
        return getImplementingTypes(
          (type as GraphQLInterfaceType).name,
          schema,
        ).map(name => schema.getType(name) as GraphQLObjectType);
      }
      return [type];
    });

    if (!hasInterfacesFromResolversMap) return unionType;

    const resolveType = typeConfig.resolveType;
    if (resolveType)
      logger.warn(
        `The "resolveType" function has already been implemented for "${unionType.name}" union which may lead to undefined behavior`,
      );
    typeConfig.resolveType = (...args) =>
      resolveType?.(...args) ?? resolversMap.Node(...args);
    return new GraphQLUnionType(typeConfig);
  }

  const finalSchema = mapSchema(addTypes(mapSchema(mapSchema(sourceSchema, {
    [MapperKind.COMPOSITE_FIELD]: mapCompositeField,
  }), {
    [MapperKind.INTERFACE_TYPE]: mapInterfaceType,
  }), [...typesToAdd.values()]), {
    [MapperKind.UNION_TYPE]: mapUnionType,
  })

  if ('Node' in resolversMap) {
    const nodeType = finalSchema.getType('Node') as GraphQLInterfaceType;
    const resolveType = nodeType.resolveType;
    if (resolveType)
      logger.warn(
        `The "resolveType" function has already been implemented for "Node" interface which may lead to undefined behavior`,
      );
    nodeType.resolveType = (...args) =>
      resolveType?.(...args) ?? resolversMap.Node(...args);
  }

  return finalSchema
}

function traverseExtends(type: GraphQLInterfaceType, schema: GraphQLSchema): GraphQLInterfaceType[] {
  const [inheritDirective] = getDirective(schema, type, 'inherit') ?? [];
  const interfaces = [
    type,
    ...type.getInterfaces().flatMap(iface => traverseExtends(iface, schema)),
  ];
  if (inheritDirective && 'interface' in inheritDirective) {
    const inheritedInterface = schema.getType(inheritDirective.interface);
    if (!isInterfaceType(inheritedInterface)) {
      throw new Error(
        `The interface "${inheritDirective.interface}" described in @inherit directive for "${type.name}" isn't abstract type or doesn't exist`,
      );
    }
    if (interfaces.includes(inheritedInterface)) {
      throw new Error(
        `The interface "${inheritDirective.interface}" described in @inherit directive for "${type.name}" is already implemented by the type`,
      );
    }

    interfaces.push(...traverseExtends(inheritedInterface, schema));
  }
  return interfaces;
}
