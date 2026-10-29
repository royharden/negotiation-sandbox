export { scriptedAction } from "./agents.ts";
export { fraction, isAttempted, isResolved, pairedDifferences, resultRows, stats, summarizeCells } from "./aggregate.ts";
export type { CellSummary, Fraction, PairedDelta, ResultRow, Stats } from "./aggregate.ts";
export { csvCell, gamesCsv, termsSummary, toCsv, turnsCsv } from "./csv.ts";
export { LIVE_CONTRACT_VERSION } from "./liveContract.ts";
export type { ConfigResponse, Disposition, ErrorResponse, ProviderCategory, TurnRequest, TurnResponse } from "./liveContract.ts";
export { bootstrapMean, summarizePairings } from "./bootstrap.ts";
export { analyzeClaims, analyzeDeception, claimIsTrue, claimTolerance, claimTruth, ownNumberCandidate } from "./deception.ts";
export type { ClaimAnalysis, ClaimEvidence } from "./deception.ts";
export { analyzeGrid, analyzeInstance, enumeratePackages, isParetoDominated } from "./enumerateGrid.ts";
export type { GridAnalysis, GridPackage } from "./enumerateGrid.ts";
export { canonicalJson, digestOf, fnv1a, isSha256Hex, sha256Hex, stableStringify, utf8Length } from "./hash.ts";
export { definitionDigest, instantiate, isInstanceSeed, verifyInstance } from "./instantiate.ts";
export { parseJsonStrict, parseWholeJsonOutput } from "./json.ts";
export { buildModelPrompt, promptFingerprint } from "./prompt.ts";
export { applyAction, buildView, initialState, maxTurns, otherRole, parseAction, parseActionJson, parseActionText, replay } from "./referee.ts";
export { drawInt, policySeedFor, streamFromParts, xorshift32 } from "./rng.ts";
export {
  boundRaw,
  fixtureSeat,
  FormatFailure,
  judgeAttempt,
  MatchCancelled,
  ModelBlocked,
  playGame,
  playMatch,
  policySeedsFor,
  ProviderFailure,
  RAW_TOO_LONG_ERROR,
  runBatch,
  runMatrix,
  scriptedDecide,
  scriptedSeat,
} from "./runner.ts";
export type { MatchExecution, MatrixProgress, Seat, SeatContext, SeatDecision } from "./runner.ts";
export { fixtureCompatible, fixtureConfig, fixtureDigest, FixtureNotApplicable, parseFixture } from "./fixtureAgent.ts";
export type { SyntheticFixture } from "./fixtureAgent.ts";
export { promptTemplate, roleObservation, templateDigest, templateDigests } from "./prompt.ts";
export type { RoleObservation } from "./prompt.ts";
export { buildRoleRequest, legalPrefixDigest, REQUEST_LIMITS } from "./request.ts";
export type { BuiltRequest, CanonicalRequest, ModelParams, RepairFeedback } from "./request.ts";
export {
  agentClass,
  agentKey,
  buildRunSpec,
  cellKey,
  findCell,
  liveExecutionDefinition,
  modelConfig,
  planMatches,
  runSpecDigest,
  SCRIPTED_POLICIES,
  scriptedConfig,
  validateRunSpec,
  worstCaseModelCalls,
} from "./runspec.ts";
export type { CellSpec, PlannedMatch, RunSpec } from "./runspec.ts";
export { buildTranscript, encodeJsonl, MAX_TRANSCRIPT_BYTES, resumeKey, verifiedResumeKey, verifyTranscript } from "./transcript.ts";
export type { TranscriptDocument, TranscriptHeader, VerificationReport } from "./transcript.ts";
export { isRecord, parseDefinition, parseScenario, parseScenarioText, toPublicScenario, variationKey } from "./scenario.ts";
export { outcomeOf, scoreGame, scoreMatch } from "./score.ts";
export {
  CLAIM_TOLERANCE,
  DAILY_TURN_LIMIT,
  ENGINE_VERSION,
  GENERATOR_FIXED,
  GENERATOR_V1,
  LIMITS,
  MAX_ATTEMPTS_PER_TURN,
  MAX_CLAIMS,
  MAX_NOTE_LENGTH,
  POLICY_VERSION,
  PROMPT_VERSION,
  PROMPT_VERSION_V2,
  SCHEMA_VERSION,
  SCORING_VERSION,
  V2_TOLERANCE,
} from "./types.ts";
export type {
  Action,
  AgentConfig,
  AgentId,
  AgentView,
  AttemptRecord,
  Claim,
  ClaimRelation,
  DeceptionReport,
  DeceptionSide,
  GameState,
  Instance,
  Issue,
  LiveCallInfo,
  MatchMetrics,
  MatchStatus,
  Outcome,
  PairingSummary,
  PlayResult,
  PlayStatus,
  PrivateCard,
  PromptVariant,
  PublicScenario,
  PublicTurn,
  Role,
  RoleMetrics,
  Scenario,
  ScenarioDefinition,
  Scores,
  ScriptedId,
  StandingOffer,
  Terms,
  TurnDeception,
  VariationTarget,
} from "./types.ts";
export { alignNumber, gridValues, issueUtility, noDealUtility, numberOnGrid, packageUtility, roleUtility, rulesetOf } from "./utility.ts";
