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
  ratings: Record<string, { skill: number; winRate: number; rank: number }>;
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
      emptyRatings[projs[i]!.id] = { skill: 0.0, winRate: 0.0, rank: i + 1 };
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
  const wins = new Array<number>(n).fill(0.01); // small Laplacian smoothing
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

  // Minorization-Maximization (MM) Iterative Algorithm
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
      nextPi[i] = denom > 0 ? wins[i]! / denom : pi[i]!;
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

  // Calculate win rates & log-odds skills
  const results: Array<{ id: string; skill: number; winRate: number }> = [];
  for (let i = 0; i < n; i++) {
    const id = projects[i]!;
    const totalMatches = matches[i]!.reduce((a, b) => a + b, 0);
    const winRate = totalMatches > 0 ? (wins[i]! - 0.01) / totalMatches : 0;
    const skill = parseFloat(Math.log(pi[i]!).toFixed(4));
    results.push({ id, skill, winRate: parseFloat(winRate.toFixed(3)) });
  }

  results.sort((a, b) => b.skill - a.skill);

  const ratings: BradleyTerryResult['ratings'] = {};
  const rankedProjectIds: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    ratings[r.id] = { skill: r.skill, winRate: r.winRate, rank: i + 1 };
    rankedProjectIds.push(r.id);
  }

  return {
    ratings,
    rankedProjectIds,
    iterations: iter + 1,
    converged,
  };
}
