import { queryAll } from '../db/index.js';

export interface PairwiseComparisonRow {
  id: string;
  judge_id: string;
  project_a: string;
  project_b: string;
  winner: 'project_a' | 'project_b' | 'tie';
  created_at: string;
}

export interface BradleyTerryResult {
  ratings: Record<string, { skill: number; elo: number; winRate: number; rank: number }>;
  rankedProjectIds: string[];
  iterations: number;
  converged: boolean;
}

export function solveBradleyTerry(
  comparisons?: PairwiseComparisonRow[],
  maxIterations = 250,
  tolerance = 1e-4
): BradleyTerryResult {
  const data = comparisons || queryAll<PairwiseComparisonRow>('SELECT * FROM pairwise_comparisons');

  // Collect all unique project IDs
  const projectSet = new Set<string>();
  for (const c of data) {
    projectSet.add(c.project_a);
    projectSet.add(c.project_b);
  }

  // If no comparisons exist yet, initialize baseline from projects table
  if (projectSet.size === 0) {
    const projs = queryAll<{ id: string }>('SELECT id FROM projects');
    const emptyRatings: BradleyTerryResult['ratings'] = {};
    for (let i = 0; i < projs.length; i++) {
      emptyRatings[projs[i]!.id] = { skill: 0.0, elo: 1500, winRate: 0.0, rank: i + 1 };
    }
    return {
      ratings: emptyRatings,
      rankedProjectIds: projs.map((p) => p.id),
      iterations: 0,
      converged: true,
    };
  }

  const projects = Array.from(projectSet);
  const n = projects.length;
  const projectIdx = new Map(projects.map((id, idx) => [id, idx]));

  // Build win vector and match count matrix
  const wins = new Array<number>(n).fill(0);
  const matches = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (const c of data) {
    const i = projectIdx.get(c.project_a);
    const j = projectIdx.get(c.project_b);
    if (i === undefined || j === undefined || i === j) continue;

    matches[i]![j]! += 1;
    matches[j]![i]! += 1;

    if (c.winner === 'project_a') {
      wins[i]! += 1.0;
    } else if (c.winner === 'project_b') {
      wins[j]! += 1.0;
    } else {
      wins[i]! += 0.5;
      wins[j]! += 0.5;
    }
  }

  // Regularized Minorization-Maximization (MM) Iterative Algorithm
  // Prior: pi_i ~ Gamma(1 + epsilon, epsilon) guarantees unique, strictly positive MLE and handles disconnected graphs
  const epsilon = 0.10;
  let pi = new Array<number>(n).fill(1.0);
  let converged = false;
  let iter = 0;

  for (iter = 0; iter < maxIterations; iter++) {
    const nextPi = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let denom = 0;
      for (let j = 0; j < n; j++) {
        if (i !== j && matches[i]![j]! > 0) {
          denom += matches[i]![j]! / (pi[i]! + pi[j]!);
        }
      }
      nextPi[i] = (wins[i]! + epsilon) / (denom + epsilon);
    }

    // Normalize so sum(pi) = n
    const sum = nextPi.reduce((a, b) => a + b, 0);
    const scale = n / (sum || 1);
    for (let i = 0; i < n; i++) {
      nextPi[i] = nextPi[i]! * scale;
    }

    // Check convergence
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(nextPi[i]! - pi[i]!));
    }

    pi = nextPi;
    if (maxDiff < tolerance) {
      converged = true;
      break;
    }
  }

  // Calculate win rates, Elo, & log-odds skills
  const results: Array<{ id: string; skill: number; elo: number; winRate: number }> = [];
  for (let i = 0; i < n; i++) {
    const id = projects[i]!;
    const totalMatches = matches[i]!.reduce((a, b) => a + b, 0);
    const winRate = totalMatches > 0 ? wins[i]! / totalMatches : 0;
    const skill = parseFloat(Math.log(pi[i]!).toFixed(4));
    const elo = Math.round(1500 + 400 * Math.log10(Math.max(1e-4, pi[i]!)));
    results.push({ id, skill, elo, winRate: parseFloat(winRate.toFixed(3)) });
  }

  results.sort((a, b) => b.skill - a.skill);

  const ratings: BradleyTerryResult['ratings'] = {};
  const rankedProjectIds: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    ratings[r.id] = { skill: r.skill, elo: r.elo, winRate: r.winRate, rank: i + 1 };
    rankedProjectIds.push(r.id);
  }

  return {
    ratings,
    rankedProjectIds,
    iterations: iter + 1,
    converged,
  };
}

/**
 * Active Pairing Selection: Fisher Information + Uncertainty Exploration
 * Maximizes information gain for latent Bradley-Terry skill convergence.
 */
export function selectActivePair<T extends { id: string }>(allProjects: T[]): [T, T] {
  if (allProjects.length < 2) return [allProjects[0]!, allProjects[1]!];

  const pairRecords = queryAll<{ project_a: string; project_b: string }>(
    'SELECT project_a, project_b FROM pairwise_comparisons'
  );
  const matchCounts: Record<string, number> = {};
  const comparedPairs = new Set<string>();
  for (const c of pairRecords) {
    matchCounts[c.project_a] = (matchCounts[c.project_a] || 0) + 1;
    matchCounts[c.project_b] = (matchCounts[c.project_b] || 0) + 1;
    comparedPairs.add(`${c.project_a}:${c.project_b}`);
    comparedPairs.add(`${c.project_b}:${c.project_a}`);
  }

  const bt = solveBradleyTerry();

  let bestPair: [T, T] = [allProjects[0]!, allProjects[1]!];
  let maxScore = -Infinity;

  // Sample candidate pairs across projects
  const shuffled = [...allProjects].sort(() => Math.random() - 0.5);
  const candidates: Array<[T, T]> = [];
  for (let i = 0; i < Math.min(shuffled.length, 12); i++) {
    for (let j = i + 1; j < Math.min(shuffled.length, i + 6); j++) {
      candidates.push([shuffled[i]!, shuffled[j]!]);
    }
  }

  for (const [pA, pB] of candidates) {
    const rA = bt.ratings[pA.id]?.elo || 1500;
    const rB = bt.ratings[pB.id]?.elo || 1500;
    const diff = Math.abs(rA - rB);
    const fisherInfo = 1 / (1 + Math.pow(10, diff / 400));
    const nA = matchCounts[pA.id] || 0;
    const nB = matchCounts[pB.id] || 0;
    const explorationBonus = 0.35 / Math.sqrt(1 + nA + nB);
    const noveltyBonus = comparedPairs.has(`${pA.id}:${pB.id}`) ? 0 : 0.25;
    const score = fisherInfo + explorationBonus + noveltyBonus;

    if (score > maxScore) {
      maxScore = score;
      bestPair = [pA, pB];
    }
  }

  return bestPair;
}

