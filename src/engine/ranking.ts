import { computeBayesianNormalization, ProjectRating } from './normalization.js';
import { solveBradleyTerry } from './pairwise.js';
import { getTeamMap, getTrackMap } from '../db/index.js';

export interface LeaderboardEntry extends ProjectRating {
  pairwiseSkill?: number;
  pairwiseRank?: number;
  compositeScore: number;
}

/**
 * Sanitize CSV cell according to RFC 4180 rules and formula injection prevention.
 */
function sanitizeCSV(val: string): string {
  if (!val) return '""';
  let clean = val.replace(/"/g, '""');
  // Neutralize potential spreadsheet formula injection (=, +, -, @, \t, \r)
  if (/^[=+\-@\t\r]/.test(clean)) {
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
  for (let i = 0; i < entries.length; i++) {
    entries[i]!.rank = i + 1;
  }

  return entries;
}

/**
 * Generate RFC 4180-compliant CSV export of current competition standings.
 */
export function generateCSVExport(): string {
  const leaderboard = generateLeaderboard();
  const teamMap = getTeamMap();
  const trackMap = getTrackMap();

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
      ].join(',')
    );
  }

  return rows.join('\r\n');
}
