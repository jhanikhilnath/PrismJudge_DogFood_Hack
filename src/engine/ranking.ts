import { computeBayesianNormalization, ProjectRating } from './normalization.js';
import { solveBradleyTerry } from './pairwise.js';

export interface LeaderboardEntry extends ProjectRating {
  pairwiseSkill?: number;
  pairwiseRank?: number;
  compositeScore: number;
}

export function generateLeaderboard(): LeaderboardEntry[] {
  const normStats = computeBayesianNormalization();
  const pairwiseStats = solveBradleyTerry();

  const entries: LeaderboardEntry[] = normStats.projectRatings.map((rating) => {
    const pt = pairwiseStats.ratings[rating.projectId];
    const pairwiseSkill = pt ? pt.skill : 0;
    const pairwiseRank = pt ? pt.rank : 0;

    // Composite: 80% normalized score + 20% pairwise bonus (centered around 70)
    const composite = rating.normalizedScore * 0.8 + (70 + pairwiseSkill * 10) * 0.2;

    return {
      ...rating,
      pairwiseSkill,
      pairwiseRank,
      compositeScore: parseFloat(composite.toFixed(3)),
    };
  });

  // Sort descending by normalized score, breaking ties by raw average then title
  entries.sort((a, b) => {
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

export function generateCSVExport(): string {
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
  ];

  const rows: string[] = [headers.join(',')];

  for (const row of leaderboard) {
    const escapedTitle = `"${row.projectTitle.replace(/"/g, '""')}"`;
    rows.push(
      [
        row.rank,
        row.projectId,
        escapedTitle,
        row.teamId,
        row.trackId,
        row.reviewCount,
        row.rawAverage,
        row.normalizedScore,
        row.compositeScore,
      ].join(',')
    );
  }

  return rows.join('\n');
}
