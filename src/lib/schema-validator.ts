/**
 * Schema validation for MCP tools and prompts
 * Validates server schemas against expected schemas from file
 */

import { readFile } from 'fs/promises';
import { ClientError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('schema-validator');

/**
 * Schema validation modes
 */
export type SchemaMode = 'strict' | 'compatible' | 'ignore';

/**
 * Tool schema (from tools/list response)
 */
export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  outputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * Prompt schema (from prompts/list response)
 */
export interface PromptSchema {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Result of schema validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Load expected schema from file
 */
export async function loadSchemaFromFile(schemaPath: string): Promise<unknown> {
  try {
    const content = await readFile(schemaPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ClientError(`Schema file not found: ${schemaPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new ClientError(`Invalid JSON in schema file: ${schemaPath}`);
    }
    throw new ClientError(`Failed to read schema file: ${(error as Error).message}`);
  }
}

/**
 * Compare two values for strict equality (deep comparison)
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();
    if (!deepEqual(aKeys, bKeys)) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}

/**
 * Validate tool schema against expected schema
 *
 * In compatible mode with passedArgs:
 * - Only validates arguments that are actually being passed
 * - Checks for new required arguments (breaking change)
 * - Ignores changes to optional arguments not being used
 */
export function validateToolSchema(
  actual: ToolSchema,
  expected: ToolSchema,
  mode: SchemaMode,
  passedArgs?: Record<string, unknown>
): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  if (mode === 'ignore') {
    return result;
  }

  logger.debug(`Validating tool schema in ${mode} mode`);

  // Check name matches
  if (actual.name !== expected.name) {
    result.errors.push(`Tool name mismatch: expected "${expected.name}", got "${actual.name}"`);
    result.valid = false;
  }

  if (mode === 'strict') {
    // Strict mode: everything must match exactly
    if (actual.description !== expected.description) {
      result.errors.push(
        `Description mismatch: expected "${expected.description}", got "${actual.description}"`
      );
      result.valid = false;
    }

    if (!deepEqual(actual.inputSchema, expected.inputSchema)) {
      result.errors.push('Input schema does not match exactly');
      result.valid = false;
    }

    if (!deepEqual(actual.outputSchema, expected.outputSchema)) {
      result.errors.push('Output schema does not match exactly');
      result.valid = false;
    }
  } else {
    // Compatible mode: focus on what matters for the call to succeed
    if (expected.inputSchema && actual.inputSchema) {
      const expectedRequired = expected.inputSchema.required || [];
      const actualRequired = actual.inputSchema.required || [];
      const expectedProps = expected.inputSchema.properties || {};
      const actualProps = actual.inputSchema.properties || {};
      const passedArgNames = passedArgs ? Object.keys(passedArgs) : null;
      const hasPassedArgs = passedArgNames && passedArgNames.length > 0;

      // Check for new required fields (breaking change - always an error)
      for (const field of actualRequired) {
        if (!expectedRequired.includes(field)) {
          // New required field - this is a breaking change
          // Only error if the arg is not being passed
          if (!hasPassedArgs || !passedArgNames.includes(field)) {
            result.errors.push(`New required field "${field}" added (breaking change)`);
            result.valid = false;
          }
        }
      }

      // If passedArgs provided (non-empty), only validate those specific arguments
      if (hasPassedArgs) {
        for (const argName of passedArgNames) {
          // Check if the argument still exists
          if (!(argName in actualProps)) {
            result.errors.push(`Argument "${argName}" no longer exists in schema`);
            result.valid = false;
            continue;
          }

          // Check type compatibility for passed arguments
          const expectedProp = expectedProps[argName] as Record<string, unknown> | undefined;
          const actualProp = actualProps[argName] as Record<string, unknown> | undefined;

          if (expectedProp && actualProp && expectedProp.type && actualProp.type !== expectedProp.type) {
            result.errors.push(
              `Argument "${argName}" type changed: expected ${JSON.stringify(expectedProp.type)}, got ${JSON.stringify(actualProp.type)}`
            );
            result.valid = false;
          }
        }
      } else {
        // No passedArgs - validate all expected properties exist
        for (const [propName, expectedProp] of Object.entries(expectedProps)) {
          if (!(propName in actualProps)) {
            result.errors.push(`Property "${propName}" is missing from input schema`);
            result.valid = false;
          } else {
            const actualProp = actualProps[propName] as Record<string, unknown> | undefined;
            const expProp = expectedProp as Record<string, unknown>;
            if (actualProp && expProp.type && actualProp.type !== expProp.type) {
              result.errors.push(
                `Property "${propName}" type changed: expected ${JSON.stringify(expProp.type)}, got ${JSON.stringify(actualProp.type)}`
              );
              result.valid = false;
            }
          }
        }

        // Check required fields are still required
        for (const field of expectedRequired) {
          if (!actualRequired.includes(field)) {
            result.errors.push(`Required field "${field}" is no longer required`);
            result.valid = false;
          }
        }
      }

      // Info about new optional fields (not an error)
      for (const propName of Object.keys(actualProps)) {
        if (!(propName in expectedProps) && !actualRequired.includes(propName)) {
          result.warnings.push(`New optional field "${propName}" added`);
        }
      }
    } else if (expected.inputSchema && !actual.inputSchema) {
      result.errors.push('Input schema was removed');
      result.valid = false;
    }
  }

  return result;
}

/**
 * Validate prompt schema against expected schema
 *
 * In compatible mode with passedArgs:
 * - Only validates arguments that are actually being passed
 * - Checks for new required arguments (breaking change)
 * - Ignores changes to optional arguments not being used
 */
export function validatePromptSchema(
  actual: PromptSchema,
  expected: PromptSchema,
  mode: SchemaMode,
  passedArgs?: Record<string, string>
): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  if (mode === 'ignore') {
    return result;
  }

  logger.debug(`Validating prompt schema in ${mode} mode`);

  // Check name matches
  if (actual.name !== expected.name) {
    result.errors.push(`Prompt name mismatch: expected "${expected.name}", got "${actual.name}"`);
    result.valid = false;
  }

  if (mode === 'strict') {
    // Strict mode: everything must match exactly
    if (actual.description !== expected.description) {
      result.errors.push(
        `Description mismatch: expected "${expected.description}", got "${actual.description}"`
      );
      result.valid = false;
    }

    if (!deepEqual(actual.arguments, expected.arguments)) {
      result.errors.push('Arguments do not match exactly');
      result.valid = false;
    }
  } else {
    // Compatible mode: focus on what matters for the call to succeed
    const expectedArgs = expected.arguments || [];
    const actualArgs = actual.arguments || [];
    const expectedRequired = expectedArgs.filter((a) => a.required).map((a) => a.name);
    const actualRequired = actualArgs.filter((a) => a.required).map((a) => a.name);
    const passedArgNames = passedArgs ? Object.keys(passedArgs) : null;
    const hasPassedArgs = passedArgNames && passedArgNames.length > 0;

    // Check for new required arguments (breaking change)
    for (const argName of actualRequired) {
      if (!expectedRequired.includes(argName)) {
        // New required argument - this is a breaking change
        // Only error if the arg is not being passed
        if (!hasPassedArgs || !passedArgNames.includes(argName)) {
          result.errors.push(`New required argument "${argName}" added (breaking change)`);
          result.valid = false;
        }
      }
    }

    // If passedArgs provided (non-empty), only validate those specific arguments
    if (hasPassedArgs) {
      for (const argName of passedArgNames) {
        const actualArg = actualArgs.find((a) => a.name === argName);
        if (!actualArg) {
          result.errors.push(`Argument "${argName}" no longer exists in schema`);
          result.valid = false;
        }
      }
    } else {
      // No passedArgs - validate all expected required arguments exist
      for (const argName of expectedRequired) {
        const actualArg = actualArgs.find((a) => a.name === argName);
        if (!actualArg) {
          result.errors.push(`Required argument "${argName}" is missing`);
          result.valid = false;
        } else if (!actualArg.required) {
          result.errors.push(`Required argument "${argName}" is no longer required`);
          result.valid = false;
        }
      }
    }

    // Info about new optional arguments (not an error)
    for (const arg of actualArgs) {
      const expectedArg = expectedArgs.find((a) => a.name === arg.name);
      if (!expectedArg && !arg.required) {
        result.warnings.push(`New optional argument "${arg.name}" added`);
      }
    }
  }

  return result;
}

/**
 * Format validation result as error message
 */
export function formatValidationError(result: ValidationResult, itemType: string): string {
  const lines: string[] = [`Schema validation failed for ${itemType}:`];

  for (const error of result.errors) {
    lines.push(`  - ${error}`);
  }

  if (result.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return lines.join('\n');
}
