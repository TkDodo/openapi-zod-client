import { ZodiosEndpointDescription } from "@zodios/core";
import {
    isReferenceObject,
    OpenAPIObject,
    OperationObject,
    ParameterObject,
    PathItemObject,
    RequestBodyObject,
    ResponseObject,
    SchemaObject,
} from "openapi3-ts";
import { get } from "pastable/server";
import { match } from "ts-pattern";
import { ConversionTypeContext, CodeMeta, getZodSchema } from "./openApiToZod";
import { tokens } from "./tokens";

export const getZodiosEndpointDescriptionFromOpenApiDoc = (doc: OpenAPIObject) => {
    const getSchemaByRef = (ref: string) => get(doc, ref.replace("#/", "").replaceAll("/", ".")) as SchemaObject;

    const endpoints = [];
    const endpointsByOperationId = {} as Record<string, EndpointDescriptionWithRefs>;
    const responsesByOperationId = {} as Record<string, Record<string, string>>;

    const ctx: ConversionTypeContext = {
        getSchemaByRef,
        zodSchemaByHash: {},
        schemaHashByRef: {},
        hashByVariableName: {},
        variableByHash: {},
    };
    const getZodVarName = (input: CodeMeta | string, fallbackName?: string) => {
        const result = input instanceof CodeMeta ? input.toString() : input;
        if (result.startsWith("z.") && fallbackName) {
            // result is simple enough that it doesn't need to be assigned to a variable
            if (!complexType.some((type) => result.startsWith(type))) {
                return result;
            }

            const hashed = tokens.makeRefAlias(result);

            // TODO opti:
            // z.union([z.string(), z.number()])
            // factoriser ça dans une seule var
            // OU ne pas mettre ça dans une variable
            // (alors que z.union([z.object(xxx), z.object(yyy)])) oui (vu que complex)

            // result is complex and would benefit from being re-used
            let formatedName = tokens.makeVarAlias(fallbackName);
            const isVarNameAlreadyUsed = Boolean(ctx.hashByVariableName[formatedName]);
            if (isVarNameAlreadyUsed) {
                if (ctx.hashByVariableName[formatedName] === hashed) {
                    return formatedName;
                } else {
                    formatedName += "__2";
                }
            }

            ctx.hashByVariableName[formatedName] = hashed;
            ctx.zodSchemaByHash[hashed] = result;
            return formatedName;
        }

        // $ref like #/components/xxx/name
        if (fallbackName) {
            const formatedName = tokens.makeVarAlias(fallbackName);
            ctx.hashByVariableName[formatedName] = result;

            return formatedName;
        }

        const ref = (input as CodeMeta)?.ref!;
        const refName = ref.split("/")[3];
        const formatedName = tokens.makeVarAlias(refName);

        ctx.hashByVariableName[formatedName] = result;

        return formatedName;
    };

    for (const path in doc.paths) {
        const pathItem = doc.paths[path] as PathItemObject;

        for (const method in pathItem) {
            const operation = pathItem[method] as OperationObject;

            const parameters = operation.parameters || [];
            const endpointDescription = {
                method,
                path,
                alias: operation.operationId,
                description: operation.description,
                requestFormat: "json",
                parameters: [] as any,
            } as EndpointDescriptionWithRefs;

            if (operation.requestBody) {
                const requestBody = operation.requestBody as RequestBodyObject;
                const bodySchema = requestBody.content?.["application/json"]?.schema;
                if (bodySchema) {
                    endpointDescription.parameters.push({
                        name: "body",
                        type: "Body",
                        description: requestBody.description,
                        schema: getZodVarName(
                            getZodSchema({ schema: bodySchema, ctx, meta: {} }),
                            operation.operationId + "-Body"
                        ),
                    });
                }
            }

            for (const param of parameters) {
                const paramItem = (isReferenceObject(param) ? getSchemaByRef(param.$ref) : param) as ParameterObject;
                if (allowedPathInValues.includes(paramItem.in)) {
                    endpointDescription.parameters.push({
                        name: paramItem.name,
                        type: match(paramItem.in)
                            .with("header", () => "Header")
                            .with("query", () => "Query")
                            .run() as "Header" | "Query",
                        schema: getZodVarName(
                            getZodSchema({
                                schema: param?.$ref ? param.$ref : (param as ParameterObject).schema,
                                ctx,
                                meta: {
                                    isRequired: paramItem.required,
                                },
                            }),
                            paramItem.name
                        ),
                    });
                }
            }

            for (const statusCode in operation.responses) {
                const responseItem = operation.responses[statusCode] as ResponseObject;
                if (responseItem.content) {
                    const isSuccess = statusCode === "200";

                    const maybeSchema = responseItem.content["application/json"].schema!;
                    if (maybeSchema) {
                        const schema = getZodSchema({ schema: maybeSchema, ctx });
                        if (isSuccess) {
                            endpointDescription.response = schema.ref ? getZodVarName(schema) : schema.toString();
                        }

                        if (endpointDescription.alias) {
                            responsesByOperationId[endpointDescription.alias] = {
                                ...responsesByOperationId[endpointDescription.alias],
                                [statusCode]: getZodVarName(
                                    getZodSchema({ schema: maybeSchema, ctx }),
                                    endpointDescription.alias
                                ),
                            };
                        }
                    }
                }
            }

            endpoints.push(endpointDescription);
            endpointsByOperationId[endpointDescription.alias] = endpointDescription;
        }
    }

    return {
        ...(ctx as Required<ConversionTypeContext>),
        endpoints,
        // endpointsByOperationId,
        responsesByOperationId,
    };
};

const allowedPathInValues = ["query", "header"] as Array<ParameterObject["in"]>;

export type EndpointDescriptionWithRefs = Required<Omit<ZodiosEndpointDescription<any>, "response" | "parameters">> & {
    response: string;
    parameters: Array<
        Omit<Required<ZodiosEndpointDescription<any>>["parameters"][number], "schema"> & { schema: string }
    >;
};

const complexType = ["z.object", "z.array", "z.union", "z.enum"] as const;