import { getStack } from "./stack.ts";

export interface DialectFunction {
  name: string;
  type: string;
  returnType?: string;
  signature: string;
  description?: string;
}

export interface DialectKeyword {
  name: string;
  /** DuckDB keyword_category: reserved | type_function | column_name | unreserved. */
  category: string;
}

export interface Dialect {
  keywords: DialectKeyword[];
  functions: DialectFunction[];
}

// Keywords + functions are static for a given DuckDB build (+ loaded extensions),
// so introspect once and cache for the process lifetime.
let cached: Dialect | undefined;

/**
 * Introspect the actual DuckDB SQL dialect from the running engine — every
 * keyword and function (with signature, return type and description) the
 * installed version and loaded extensions expose. Sourced from the engine so
 * it's always correct, not a hand-maintained list.
 */
export async function getDialect(): Promise<Dialect> {
  if (cached) return cached;
  const { duck } = await getStack();

  const kw = await duck.runAndReadAll(
    "SELECT keyword_name, keyword_category FROM duckdb_keywords() ORDER BY keyword_name",
  );
  const keywords: DialectKeyword[] = kw.getRowObjects().map((r) => ({
    name: String(r.keyword_name).toUpperCase(),
    category: String(r.keyword_category),
  }));

  // Collapse overloads to one entry per name; array_to_string turns the parameter
  // name list into a readable signature.
  const fn = await duck.runAndReadAll(`
    SELECT function_name,
           any_value(function_type)                     AS function_type,
           any_value(return_type)                       AS return_type,
           any_value(description)                       AS description,
           any_value(array_to_string(parameters, ', ')) AS param_names
    FROM duckdb_functions()
    WHERE function_type IN ('scalar', 'aggregate', 'macro', 'table')
      -- keep real, user-facing names: drop operator-style entries (!~~, +, …)
      -- and internal helpers (__internal_*) by requiring a leading letter
      AND regexp_matches(function_name, '^[a-z][a-z0-9_]*$')
    GROUP BY function_name
    ORDER BY function_name
  `);
  const functions: DialectFunction[] = fn.getRowObjects().map((r) => {
    const name = String(r.function_name);
    const params = r.param_names == null ? "" : String(r.param_names);
    return {
      name,
      type: String(r.function_type),
      returnType: r.return_type == null ? undefined : String(r.return_type),
      signature: `${name}(${params})`,
      description: r.description == null ? undefined : String(r.description),
    };
  });

  cached = { keywords, functions };
  return cached;
}
