/**
 * SinwanJS Compiler — shared core.
 *
 * Exports the JSX transform, reactive prop analysis, and metadata helpers
 * used by the Bun and Vite plugins.
 */

export { transformJSX, type TransformOptions } from "./transform";
export {
  analyze,
  analyzeProject,
  analyzeModule,
  loadMetadata,
  AnalyzerCache,
  type AnalyzeOptions,
  type ModuleAnalysis,
  type ProjectAnalysis,
  type ImportedCallSite,
  type ImportInfo,
  type WorkspacesConfig,
} from "./analyze";

export { runAnalyzeCli } from "./cli";
export {
  wrapReactiveExpressions,
  trackReactiveImports,
  collectComponentFunctions,
  computeLocalScopes,
  collectComponentCallGraph,
  propagateReactiveProps,
  buildFullScope,
  containsReactiveValue,
  getAllPropNames,
  isReactiveValue,
  type ReactiveScope,
  type Binding,
  type CallSite,
  type ImportNames,
} from "./reactive-wrap";
