import { computeBayesianNormalization, ProjectRating } from './normalization.js';
import { solveBradleyTerry } from './pairwise.js';
import { getTeamMap, getTrackMap, queryAll } from '../db/index.js';

export interface LeaderboardEntry extends ProjectRating {
  pairwiseSkill?: number;
  pairwiseRank?: number;
  compositeScore: number;
}

/**
 * Sanitize CSV cell according to RFC 4180 rules and formula injection prevention.
 */
function sanitizeCSV(val: string | null | undefined): string {
  if (val === null || val === undefined) return '""';
  let clean = String(val).replace(/"/g, '""');
  // Neutralize potential spreadsheet formula injection (=, +, -, @, \t, \r, |, %) even with leading whitespace
  if (/^\s*[=+\-@\t\r\|%]/.test(clean)) {
    clean = `'${clean}`;
  }
  return `"${clean}"`;
}

/**
 * Generate composite leaderboard synthesizing Bayesian normalized score (80%)
 * and latent Bradley-Terry pairwise skill (20%).
 */
export function generateLeaderboard(): LeaderboardEntry[] {
  const normStats = computeBayesianNormalization();
  const pairwiseStats = solveBradleyTerry();

  const entries: LeaderboardEntry[] = normStats.projectRatings.map((rating) => {
    const pt = pairwiseStats.ratings[rating.projectId];
    const pairwiseSkill = pt ? pt.skill : 0;
    const pairwiseRank = pt ? pt.rank : 0;

    // Composite: 80% normalized score + 20% pairwise bonus (centered around 70)
    // If a project has 0 reviews, its composite score is strictly 0.00
    const composite = rating.reviewCount === 0
      ? 0
      : rating.normalizedScore * 0.8 + (70 + pairwiseSkill * 10) * 0.2;

    return {
      ...rating,
      pairwiseSkill,
      pairwiseRank,
      compositeScore: parseFloat(composite.toFixed(3)),
    };
  });

  // Sort descending by composite score, breaking ties by normalized score, raw average, then title
  entries.sort((a, b) => {
    if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
    if (b.normalizedScore !== a.normalizedScore) return b.normalizedScore - a.normalizedScore;
    if (b.rawAverage !== a.rawAverage) return b.rawAverage - a.rawAverage;
    return a.projectTitle.localeCompare(b.projectTitle);
  });

  // Re-rank sequentially
  // Re-rank sequentially and calculate rankDelta relative to rawRank
  for (let i = 0; i < entries.length; i++) {
    entries[i]!.rank = i + 1;
    entries[i]!.rankDelta = (entries[i]!.rawRank || entries[i]!.rank) - (i + 1);
  }

  return entries;
}

/**
 * Generate RFC 4180-compliant CSV export supporting multi-stage telemetry.
 * Stages:
 * - 'composite' (default): Full synthesized final leaderboard
 * - 'raw': All individual evaluator rubric scores
 * - 'normalized': Bayesian adjusted ratings with rank movement deltas
 * - 'pairwise': Bradley-Terry head-to-head match records
 * - 'audit': Append-only system mutation ledger
 */
export function generateCSVExport(stage: string = 'composite'): string {
  const teamMap = getTeamMap();
  const trackMap = getTrackMap();

  if (stage === 'raw') {
    const rawScores = queryAll<{
      id: string;
      judge_id: string;
      project_id: string;
      raw_total: number;
      criteria: string;
      comment: string | null;
      submitted_at: string;
      judge_name?: string;
      project_title?: string;
      track_id?: string;
    }>(
      `SELECT s.id, s.judge_id, s.project_id, s.raw_total, s.criteria, s.comment, s.submitted_at,
              u.name as judge_name, p.title as project_title, p.track_id
       FROM scores s
       LEFT JOIN users u ON s.judge_id = u.id
       LEFT JOIN projects p ON s.project_id = p.id
       ORDER BY s.submitted_at ASC`
    );

    const headers = [
      'score_id',
      'judge_id',
      'judge_name',
      'project_id',
      'project_title',
      'track_id',
      'functionality',
      'quality',
      'innovation',
      'impact',
      'raw_total',
      'comment',
      'submitted_at',
    ];

    const rows: string[] = [headers.join(',')];
    for (const s of rawScores) {
      let c: any = {};
      try {
        c = JSON.parse(s.criteria || '{}');
      } catch {
        c = {};
      }
      rows.push(
        [
          s.id,
          s.judge_id,
          sanitizeCSV(s.judge_name || s.judge_id),
          s.project_id,
          sanitizeCSV(s.project_title || s.project_id),
          s.track_id || '',
          c.functionality ?? '',
          c.quality ?? '',
          c.innovation ?? '',
          c.impact ?? '',
          s.raw_total.toFixed(2),
          sanitizeCSV(s.comment || ''),
          s.submitted_at,
        ].join(',')
      );
    }
    return rows.join('\r\n');
  }

  if (stage === 'normalized') {
    const norm = computeBayesianNormalization();
    const headers = [
      'rank',
      'raw_rank',
      'rank_delta',
      'project_id',
      'title',
      'track_id',
      'review_count',
      'raw_average',
      'normalized_score',
    ];
    const rows: string[] = [headers.join(',')];
    for (const p of norm.projectRatings) {
      rows.push(
        [
          p.rank,
          p.rawRank ?? p.rank,
          p.rankDelta ?? 0,
          p.projectId,
          sanitizeCSV(p.projectTitle),
          p.trackId,
          p.reviewCount,
          p.rawAverage.toFixed(2),
          p.normalizedScore.toFixed(2),
        ].join(',')
      );
    }
    return rows.join('\r\n');
  }

  if (stage === 'pairwise') {
    const comparisons = queryAll<{
      id: string;
      judge_id: string;
      project_a: string;
      project_b: string;
      winner: string | null;
      created_at: string;
    }>('SELECT id, judge_id, project_a, project_b, winner, created_at FROM pairwise_comparisons ORDER BY created_at ASC');

    const headers = ['comparison_id', 'judge_id', 'project_a', 'project_b', 'winner', 'created_at'];
    const rows: string[] = [headers.join(',')];
    for (const c of comparisons) {
      rows.push([
        sanitizeCSV(c.id),
        sanitizeCSV(c.judge_id),
        sanitizeCSV(c.project_a),
        sanitizeCSV(c.project_b),
        sanitizeCSV(c.winner || 'TIE'),
        sanitizeCSV(c.created_at),
      ].join(','));
    }
    return rows.join('\r\n');
  }

  if (stage === 'audit') {
    const auditLogs = queryAll<{
      id: string;
      created_at: string;
      actor_id: string | null;
      actor_role: string | null;
      action: string;
      resource_type: string;
      resource_id: string | null;
      ip_address: string | null;
    }>('SELECT id, created_at, actor_id, actor_role, action, resource_type, resource_id, ip_address FROM audit_logs ORDER BY created_at DESC');

    const headers = ['id', 'timestamp', 'actor_id', 'actor_role', 'action', 'resource_type', 'resource_id', 'ip_address'];
    const rows: string[] = [headers.join(',')];
    for (const log of auditLogs) {
      rows.push(
        [
          sanitizeCSV(log.id),
          sanitizeCSV(log.created_at),
          sanitizeCSV(log.actor_id || ''),
          sanitizeCSV(log.actor_role || ''),
          sanitizeCSV(log.action),
          sanitizeCSV(log.resource_type),
          sanitizeCSV(log.resource_id || ''),
          sanitizeCSV(log.ip_address || ''),
        ].join(',')
      );
    }
    return rows.join('\r\n');
  }

  // Default: Composite leaderboard
  const leaderboard = generateLeaderboard();

  const headers = [
    'rank',
    'project_id',
    'title',
    'team_id',
    'track_id',
    'review_count',
    'raw_average',
    'normalized_score',
    'composite_score',
    'team_name',
    'track_name',
    'raw_rank',
    'rank_delta',
  ];

  const rows: string[] = [headers.join(',')];

  for (const row of leaderboard) {
    const escapedTitle = sanitizeCSV(row.projectTitle);
    const escapedTeamName = sanitizeCSV(teamMap.get(row.teamId) || row.teamId);
    const escapedTrackName = sanitizeCSV(trackMap.get(row.trackId) || row.trackId);
    rows.push(
      [
        row.rank,
        row.projectId,
        escapedTitle,
        row.teamId,
        row.trackId,
        row.reviewCount,
        row.rawAverage.toFixed(2),
        row.normalizedScore.toFixed(2),
        row.compositeScore.toFixed(2),
        escapedTeamName,
        escapedTrackName,
        row.rawRank ?? row.rank,
        row.rankDelta ?? 0,
      ].join(',')
    );
  }

  return rows.join('\r\n');
}
