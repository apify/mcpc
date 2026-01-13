/**
 * JSON Schema to TypeScript type converter
 *
 * Converts JSON Schema definitions to TypeScript type declarations.
 * Used by the codegen command to generate typed stubs for MCP servers.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number | boolean | null)[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  description?: string;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  const?: unknown;
}

export interface GeneratedType {
  /** The TypeScript type expression (e.g., "string", "MyInterface") */
  typeExpression: string;
  /** Any interface definitions that need to be declared (for nested objects) */
  declarations: string[];
}

/**
 * Converts a JSON Schema to a TypeScript type expression.
 *
 * @param schema - The JSON Schema to convert
 * @param name - Name to use for generated interface (for object types)
 * @param required - Whether this property is required (affects optionality)
 * @returns Generated type information
 */
export function jsonSchemaToTs(
  schema: JsonSchema,
  name: string,
  _required = true,
): GeneratedType {
  const declarations: string[] = [];

  // Handle $ref (just extract the type name, preserving its original case)
  if (schema.$ref) {
    const refName = schema.$ref.split('/').pop() || 'Unknown';
    return { typeExpression: refName, declarations };
  }

  // Handle const
  if (schema.const !== undefined) {
    return { typeExpression: JSON.stringify(schema.const), declarations };
  }

  // Handle enum
  if (schema.enum) {
    const enumType = schema.enum
      .map((v) => (typeof v === 'string' ? `'${escapeString(v)}'` : String(v)))
      .join(' | ');
    return { typeExpression: enumType, declarations };
  }

  // Handle oneOf / anyOf (union types)
  if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf || schema.anyOf || [];
    const types: string[] = [];

    variants.forEach((variant, index) => {
      const variantName = `${name}Variant${index + 1}`;
      const result = jsonSchemaToTs(variant, variantName, true);
      types.push(result.typeExpression);
      declarations.push(...result.declarations);
    });

    return { typeExpression: types.join(' | '), declarations };
  }

  // Handle allOf (intersection types)
  if (schema.allOf) {
    const types: string[] = [];

    schema.allOf.forEach((variant, index) => {
      const variantName = `${name}Part${index + 1}`;
      const result = jsonSchemaToTs(variant, variantName, true);
      types.push(result.typeExpression);
      declarations.push(...result.declarations);
    });

    return { typeExpression: types.join(' & '), declarations };
  }

  // Handle type array (union of types)
  if (Array.isArray(schema.type)) {
    const types = schema.type.map((t) => primitiveTypeToTs(t));
    return { typeExpression: types.join(' | '), declarations };
  }

  // Handle single type
  const type = schema.type || 'object';

  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return { typeExpression: primitiveTypeToTs(type), declarations };

    case 'array': {
      if (schema.items) {
        const itemResult = jsonSchemaToTs(schema.items, `${name}Item`, true);
        declarations.push(...itemResult.declarations);
        return { typeExpression: `${itemResult.typeExpression}[]`, declarations };
      }
      return { typeExpression: 'unknown[]', declarations };
    }

    case 'object': {
      // No properties defined - use Record type
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        if (schema.additionalProperties === true || schema.additionalProperties === undefined) {
          return { typeExpression: 'Record<string, unknown>', declarations };
        }
        if (typeof schema.additionalProperties === 'object') {
          const valueResult = jsonSchemaToTs(schema.additionalProperties, `${name}Value`, true);
          declarations.push(...valueResult.declarations);
          return { typeExpression: `Record<string, ${valueResult.typeExpression}>`, declarations };
        }
        // additionalProperties === false with no properties
        return { typeExpression: 'Record<string, never>', declarations };
      }

      // Generate interface for object with properties
      const interfaceDecl = generateInterface(schema, name, declarations);
      declarations.push(interfaceDecl);
      return { typeExpression: name, declarations };
    }

    default:
      return { typeExpression: 'unknown', declarations };
  }
}

/**
 * Generate a TypeScript interface from an object schema.
 */
function generateInterface(
  schema: JsonSchema,
  name: string,
  declarations: string[],
): string {
  const lines: string[] = [];
  const requiredProps = new Set(schema.required || []);

  lines.push(`export interface ${name} {`);

  for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
    const isRequired = requiredProps.has(propName);
    const hasDefault = propSchema.default !== undefined;
    const isOptional = !isRequired || hasDefault;

    // Generate nested type
    const nestedName = `${name}${toPascalCase(propName)}`;
    const result = jsonSchemaToTs(propSchema, nestedName, isRequired);

    // Add nested declarations
    declarations.push(...result.declarations);

    // Build JSDoc comment
    const jsdocLines: string[] = [];
    if (propSchema.description) {
      jsdocLines.push(propSchema.description);
    }
    if (hasDefault) {
      jsdocLines.push(`@default ${JSON.stringify(propSchema.default)}`);
    }

    if (jsdocLines.length > 0) {
      lines.push('  /**');
      for (const line of jsdocLines) {
        lines.push(`   * ${line}`);
      }
      lines.push('   */');
    }

    // Property declaration
    const safePropName = isValidIdentifier(propName) ? propName : `'${escapeString(propName)}'`;
    const optionalMarker = isOptional ? '?' : '';
    lines.push(`  ${safePropName}${optionalMarker}: ${result.typeExpression};`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Convert a JSON Schema primitive type to TypeScript.
 */
function primitiveTypeToTs(type: string): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    default:
      return 'unknown';
  }
}

/**
 * Convert a string to PascalCase for interface names.
 * Handles various input formats: kebab-case, snake_case, spaces, special chars, etc.
 */
export function toPascalCase(str: string): string {
  if (!str) return 'Unknown';

  // Split on any non-alphanumeric characters (preserving numbers)
  const words = str
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) return 'Unknown';

  // Capitalize first letter of each word
  const pascal = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');

  // If result starts with a number, prefix with underscore
  if (/^[0-9]/.test(pascal)) {
    return '_' + pascal;
  }

  return pascal;
}

/**
 * Convert a string to camelCase for function names.
 * Handles various input formats: kebab-case, snake_case, spaces, special chars, etc.
 */
export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  if (!pascal) return 'unknown';

  // Lowercase the first character (or first letter after underscore prefix)
  if (pascal.startsWith('_')) {
    return '_' + pascal.charAt(1).toLowerCase() + pascal.slice(2);
  }
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Deduplicate function names by adding numeric suffixes to duplicates.
 * Returns a map from original name to deduplicated camelCase name.
 */
export function deduplicateNames(names: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const usedNames = new Map<string, number>(); // camelCase name -> count

  for (const name of names) {
    const camelCase = toCamelCase(name);
    const count = usedNames.get(camelCase) || 0;

    if (count === 0) {
      // First occurrence - use as-is
      result.set(name, camelCase);
      usedNames.set(camelCase, 1);
    } else {
      // Duplicate - add numeric suffix
      const suffix = count + 1;
      result.set(name, `${camelCase}${suffix}`);
      usedNames.set(camelCase, suffix);
    }
  }

  return result;
}

/**
 * Check if a string is a valid JavaScript identifier.
 */
function isValidIdentifier(str: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
}

/**
 * Escape a string for use in a TypeScript string literal.
 */
function escapeString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Generate TypeScript type declarations for a tool's input and output schemas.
 *
 * @param toolName - Name of the tool (used for interface naming)
 * @param inputSchema - The tool's inputSchema
 * @param outputSchema - The tool's outputSchema (optional)
 * @returns TypeScript code declaring the input/output types
 */
export function generateToolTypes(
  toolName: string,
  inputSchema: JsonSchema,
  outputSchema?: JsonSchema,
): string {
  const baseName = toPascalCase(toolName);
  const lines: string[] = [];

  // Generate input type
  const inputName = `${baseName}Input`;
  const inputResult = jsonSchemaToTs(inputSchema, inputName, true);

  // Add declarations (nested interfaces)
  for (const decl of inputResult.declarations) {
    lines.push(decl);
    lines.push('');
  }

  // Generate output type if present
  if (outputSchema) {
    const outputName = `${baseName}Output`;
    const outputResult = jsonSchemaToTs(outputSchema, outputName, true);

    for (const decl of outputResult.declarations) {
      lines.push(decl);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}
