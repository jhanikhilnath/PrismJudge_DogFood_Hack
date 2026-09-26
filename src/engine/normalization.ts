import { queryAll } from '../db/index.js';

export interface ScoreRow {
  judge_id: string;
  project_id: string;
  criteria: string;
  raw_total: number;
}

export interface ProjectRating {
  projectId: string;
  projectTitle: string;
  teamId: string;
  trackId: string;
  reviewCount: number;
  rawAverage: number;
  normalizedScore: number;
  rank: number;
}

export interface NormalizationStats {
  globalMean: number;
  globalStd: number;
  judgeStats: Record<
    string,
    {
      reviewCount: number;
      sampleMean: number;
      sampleStd: number;
      shrunkMean: number;
      shrunkStd: number;
    }
  >;
  projectRatings: ProjectRating[];
}

export function computeBayesianNormalization(
  rubricWeights: Record<string, number> = { functionality: 0.4, quality: 0.3, innovation: 0.3 },
  shrinkageWeight = 3.0
): NormalizationStats {
  const scores = queryAll<ScoreRow>('SELECT judge_id, project_id, criteria, raw_total FROM scores');
  const projects = queryAll<{ id: string; title: string; team_id: string; track_id: string }>(
    'SELECT id, title, team_id, track_id FROM projects'
  );

  if (scores.length === 0) {
    return {
      globalMean: 0,
      globalStd: 1,
      judgeStats: {},
      projectRatings: [],
    };
  }

  // 1. Calculate each score's weighted raw value
  const processedScores: Array<{
    judgeId: string;
    projectId: string;
    score: number;
  }> = [];

  for (const s of scores) {
    let scoreVal = s.raw_total;
    try {
      const criteriaObj = typeof s.criteria === 'string' ? JSON.parse(s.criteria) : s.criteria;
      let computed = 0;
      let weightSum = 0;
      for (const [k, w] of Object.entries(rubricWeights)) {
        if (criteriaObj[k] !== undefined) {
          computed += criteriaObj[k] * w;
          weightSum += w;
        }
      }
      if (weightSum > 0) {
        scoreVal = computed / weightSum;
      }
    } catch {
      // fallback to s.raw_total
    }
    processedScores.push({
      judgeId: s.judge_id,
      projectId: s.project_id,
      score: scoreVal,
    });
  }

  // 2. Compute global prior mean & variance
  const allValues = processedScores.map((p) => p.score);
  const N = allValues.length;
  const globalMean = allValues.reduce((a, b) => a + b, 0) / N;

  const sumSquaredDiff = allValues.reduce((acc, v) => acc + Math.pow(v - globalMean, 2), 0);
  const globalVariance = N > 1 ? sumSquaredDiff / (N - 1) : 1.0;
  const globalStd = Math.sqrt(globalVariance) || 1.0;

  // 3. Group by judge to compute sample and shrunk parameters
  const judgeGroups: Record<string, number[]> = {};
  for (const item of processedScores) {
    if (!judgeGroups[item.judgeId]) {
      judgeGroups[item.judgeId] = [];
    }
    judgeGroups[item.judgeId]!.push(item.score);
  }

  const judgeStats: NormalizationStats['judgeStats'] = {};

  for (const [judgeId, vals] of Object.entries(judgeGroups)) {
    const n = vals.length;
    const sampleMean = vals.reduce((a, b) => a + b, 0) / n;
    let sampleVar = 0;
    if (n > 1) {
      const sqDiffs = vals.reduce((acc, v) => acc + Math.pow(v - sampleMean, 2), 0);
      sampleVar = sqDiffs / (n - 1);
    } else {
      sampleVar = globalVariance;
    }
    const sampleStd = Math.sqrt(sampleVar);

    // Empirical Bayesian Shrinkage
    // Posterior Mean
    const shrunkMean = (n * sampleMean + shrinkageWeight * globalMean) / (n + shrinkageWeight);

    // Posterior Variance with prior shrinkage
    // Avoids singularity when sampleVar === 0 (e.g. jdg_07 where all scores are 4)
    const dof = Math.max(1, n - 1);
    const shrunkVar = (dof * sampleVar + shrinkageWeight * globalVariance) / (dof + shrinkageWeight);
    const shrunkStd = Math.sqrt(shrunkVar) || globalStd;

    judgeStats[judgeId] = {
      reviewCount: n,
      sampleMean,
      sampleStd,
      shrunkMean,
      shrunkStd,
    };
  }

  // 4. Compute normalized scores per project
  const projectScores: Record<string, { raw: number[]; norm: number[] }> = {};
  for (const p of projects) {
    projectScores[p.id] = { raw: [], norm: [] };
  }

  for (const item of processedScores) {
    const stats = judgeStats[item.judgeId]!;
    // Z-score with shrunk parameters
    const z = (item.score - stats.shrunkMean) / stats.shrunkStd;

    // Rescale to 0-100 target scale (center at 70, std 12)
    const scaledScore = Math.min(100, Math.max(0, 70 + z * 12));

    if (!projectScores[item.projectId]) {
      projectScores[item.projectId] = { raw: [], norm: [] };
    }
    projectScores[item.projectId]!.raw.push(item.score);
    projectScores[item.projectId]!.norm.push(scaledScore);
  }

  // 5. Build project ratings list
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const ratings: ProjectRating[] = [];

  for (const [projId, sc] of Object.entries(projectScores)) {
    const proj = projectMap.get(projId);
    const reviewCount = sc.raw.length;
    const rawAvg = reviewCount > 0 ? sc.raw.reduce((a, b) => a + b, 0) / reviewCount : 0;
    const normAvg = reviewCount > 0 ? sc.norm.reduce((a, b) => a + b, 0) / reviewCount : 0;

    ratings.push({
      projectId: projId,
      projectTitle: proj ? proj.title : projId,
      teamId: proj ? proj.team_id : '',
      trackId: proj ? proj.track_id : '',
      reviewCount,
      rawAverage: parseFloat(rawAvg.toFixed(3)),
      normalizedScore: parseFloat(normAvg.toFixed(3)),
      rank: 0,
    });
  }

  // 6. Rank descending by normalized score
  ratings.sort((a, b) => b.normalizedScore - a.normalizedScore || b.rawAverage - a.rawAverage);
  for (let i = 0; i < ratings.length; i++) {
    ratings[i]!.rank = i + 1;
  }

  return {
    globalMean: parseFloat(globalMean.toFixed(3)),
    globalStd: parseFloat(globalStd.toFixed(3)),
    judgeStats,
    projectRatings: ratings,
  };
}
