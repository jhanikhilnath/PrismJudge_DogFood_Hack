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

export interface JudgeDiagnostic {
  reviewCount: number;
  sampleMean: number;
  sampleStd: number;
  shrunkMean: number;
  shrunkStd: number;
  severity: number;
  calibrationStatus: 'Strict Judge' | 'Balanced' | 'Generous Judge' | 'Singularity Handled';
  confidenceWeight: number;
}

export interface NormalizationStats {
  globalMean: number;
  globalStd: number;
  interRaterReliability: number;
  underservedProjectsCount: number;
  judgeStats: Record<string, JudgeDiagnostic>;
  projectRatings: ProjectRating[];
}

/**
 * Calculate the weighted raw score from a criteria evaluation object.
 * Reconciles the standard 4-criterion model (40% functionality, 30% quality, 20% innovation, 10% impact)
 * with graceful fallback for legacy 3-criterion seeds without impact (40% functionality, 30% quality, 30% innovation).
 */
export function calculateWeightedScore(
  criteria: Record<string, any>,
  customWeights?: Record<string, number>
): number {
  if (customWeights && Object.keys(customWeights).length > 0) {
    let computed = 0;
    let weightSum = 0;
    for (const [k, w] of Object.entries(customWeights)) {
      if (criteria[k] !== undefined) {
        computed += Number(criteria[k]) * w;
        weightSum += w;
      }
    }
    if (weightSum > 0) {
      return Math.round((computed / weightSum) * 100) / 100;
    }
  }

  const func = Number(criteria.functionality ?? 3);
  const qual = Number(criteria.quality ?? 3);
  const inno = Number(criteria.innovation ?? 3);

  let rawTotal = 0;
  if (criteria.impact !== undefined) {
    const imp = Number(criteria.impact);
    rawTotal = func * 0.40 + qual * 0.30 + inno * 0.20 + imp * 0.10;
  } else {
    rawTotal = func * 0.40 + qual * 0.30 + inno * 0.30;
  }

  return Math.round(rawTotal * 100) / 100;
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
      interRaterReliability: 1.0,
      underservedProjectsCount: 0,
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
      scoreVal = calculateWeightedScore(criteriaObj, rubricWeights);
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

    const severity = parseFloat((sampleMean - globalMean).toFixed(3));
    let calibrationStatus: JudgeDiagnostic['calibrationStatus'] = 'Balanced';
    if (sampleStd === 0) {
      calibrationStatus = 'Singularity Handled';
    } else if (severity < -0.2) {
      calibrationStatus = 'Strict Judge';
    } else if (severity > 0.2) {
      calibrationStatus = 'Generous Judge';
    }
    const confidenceWeight = parseFloat((n / (n + shrinkageWeight)).toFixed(2));

    judgeStats[judgeId] = {
      reviewCount: n,
      sampleMean: parseFloat(sampleMean.toFixed(3)),
      sampleStd: parseFloat(sampleStd.toFixed(3)),
      shrunkMean: parseFloat(shrunkMean.toFixed(3)),
      shrunkStd: parseFloat(shrunkStd.toFixed(3)),
      severity,
      calibrationStatus,
      confidenceWeight,
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

  // 7. Compute Inter-Rater Reliability (ICC 1,1) across multi-reviewed projects
  const multiReviewed = Object.values(projectScores).filter((p) => p.raw.length >= 2);
  let interRaterReliability = 0.85; // baseline default
  if (multiReviewed.length > 0) {
    const kSum = multiReviewed.reduce((acc, p) => acc + p.raw.length, 0);
    const kAvg = kSum / multiReviewed.length;
    // Two-Way Random Effects ANOVA (Shrout & Fleiss 1979): separates judge severity effects from evaluation error
    let ssProjects = 0;
    for (const p of multiReviewed) {
      const pMean = p.raw.reduce((a, b) => a + b, 0) / p.raw.length;
      ssProjects += p.raw.length * Math.pow(pMean - globalMean, 2);
    }
    let ssJudges = 0;
    for (const j of Object.values(judgeStats)) {
      ssJudges += j.reviewCount * Math.pow(j.sampleMean - globalMean, 2);
    }
    const ssTotal = allValues.reduce((acc, v) => acc + Math.pow(v - globalMean, 2), 0);
    const ssError = Math.max(0, ssTotal - ssProjects - ssJudges);
    const dfProjects = multiReviewed.length - 1;
    const dfJudges = Object.keys(judgeStats).length - 1;
    const dfError = Math.max(1, N - 1 - dfProjects - dfJudges);
    const msProjects = dfProjects > 0 ? ssProjects / dfProjects : 1.0;
    const msError = ssError / dfError;
    const denom = msProjects + (kAvg - 1) * msError;
    if (denom > 0) {
      const twoWayIcc = (msProjects - msError) / denom;
      interRaterReliability = parseFloat(Math.max(0, Math.min(1.0, twoWayIcc)).toFixed(3));
    }
  }

  const underservedProjectsCount = ratings.filter((r) => r.reviewCount < 3).length;

  return {
    globalMean: parseFloat(globalMean.toFixed(3)),
    globalStd: parseFloat(globalStd.toFixed(3)),
    interRaterReliability,
    underservedProjectsCount,
    judgeStats,
    projectRatings: ratings,
  };
}
