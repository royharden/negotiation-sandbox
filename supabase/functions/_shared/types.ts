export const SCHEMA_VERSION = 1 as const;
export const PROMPT_VERSION = "nsb-prompt-v1";
export const MAX_NOTE_LENGTH = 280;
export const MAX_CLAIMS = 8;
export const CLAIM_TOLERANCE = 0.5;
export const DAILY_TURN_LIMIT = 40;

export type Role = "buyer" | "seller";
export type ScriptedId = "concession" | "firm" | "bluff";
export type AgentId = ScriptedId | "model";

export type NumberIssue = {
  id: string;
  label: string;
  kind: "number";
  min: number;
  max: number;
  step: number;
  unit?: string;
};

export type ChoiceIssue = {
  id: string;
  label: string;
  kind: "choice";
  options: string[];
};

export type Issue = NumberIssue | ChoiceIssue;

export type NumberScore = {
  kind: "number";
  atMin: number;
  atMax: number;
};

export type ChoiceScore = {
  kind: "choice";
  options: Record<string, number>;
};

export type IssueScore = NumberScore | ChoiceScore;

export type PrivateCard = {
  reservationUtility: number;
  scores: Record<string, IssueScore>;
};

export type Party = {
  publicBrief: string;
  private: PrivateCard;
};

export type Rules = {
  maxRounds: number;
  openingRole: Role;
  disagreementUtility: number;
};

export type Scenario = {
  schemaVersion: 1;
  id: string;
  title: string;
  publicBrief: string;
  issues: Issue[];
  parties: Record<Role, Party>;
  rules: Rules;
};

export type PublicScenario = {
  schemaVersion: 1;
  id: string;
  title: string;
  publicBrief: string;
  issues: Issue[];
  parties: Record<Role, { publicBrief: string }>;
  rules: Rules;
};

export type Terms = Record<string, number | string>;

export type Claim =
  | { about: "reservation"; stated: number }
  | { about: "number-score"; issueId: string; endpoint: "min" | "max"; stated: number }
  | { about: "choice-score"; issueId: string; option: string; stated: number };

export type Action = {
  type: "offer" | "accept" | "walk";
  terms?: Terms;
  note?: string;
  claims?: Claim[];
};

export type PublicTurn = {
  role: Role;
  action: Action;
};

export type StandingOffer = {
  role: Role;
  terms: Terms;
};

export type Terminal =
  | { kind: "agreement"; terms: Terms }
  | { kind: "disagreement"; reason: "walk" | "cap" };

export type GameState = {
  nextRole: Role;
  turnsPlayed: number;
  standing: StandingOffer | null;
  history: PublicTurn[];
  terminal: Terminal | null;
};

export type AgentView = {
  role: Role;
  seed: number;
  maxRounds: number;
  maxTurns: number;
  turnsPlayed: number;
  publicScenario: PublicScenario;
  ownPrivate: PrivateCard;
  history: PublicTurn[];
  standing: StandingOffer | null;
};

export type DeceptionSide = {
  claimCount: number;
  violations: number;
  drifts: number;
  leakages: number;
};

export type TurnDeception = {
  violations: string[];
  drifts: string[];
  leakages: string[];
};

export type DeceptionReport = {
  buyer: DeceptionSide;
  seller: DeceptionSide;
  turns: TurnDeception[];
};

export type Scores = {
  outcome: "agreement" | "disagreement" | "format_failure";
  terminalReason: string | null;
  agreedTerms: Terms | null;
  buyerUtility: number | null;
  sellerUtility: number | null;
  welfare: number | null;
  surplus: number | null;
  buyerShare: number | null;
  buyerIndividuallyRational: boolean | null;
  sellerIndividuallyRational: boolean | null;
  turns: number;
  rounds: number;
  buyer: DeceptionSide;
  seller: DeceptionSide;
  failureRole: Role | null;
  failureReason: string | null;
};

export type PlayStatus = "complete" | "format_failure" | "blocked";

export type PlayResult = {
  seed: number;
  buyerAgent: AgentId;
  sellerAgent: AgentId;
  status: PlayStatus;
  history: PublicTurn[];
  scores: Scores | null;
  promptHash: string;
  error?: string;
};

export type PairingSummary = {
  buyerAgent: AgentId;
  sellerAgent: AgentId;
  played: number;
  agreements: number;
  disagreements: number;
  failures: number;
  blocked: number;
  meanWelfare: number | null;
  welfareLow: number | null;
  welfareHigh: number | null;
  buyerViolations: number;
  sellerViolations: number;
};
