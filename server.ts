import express, { Request, Response } from 'express';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Dev server must strictly run on port 3000 as required by runtime environment
const PORT = 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Initialize Gemini SDK with telemetry user-agent header
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// Administrator Password & Email Configuration (server-side only, never exposed to client)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Softman@1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'alisuleman8856@gmail.com';

// Active Admin Sessions (token -> expiry timestamp)
const activeAdminSessions = new Map<string, number>();

// Clean expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of activeAdminSessions.entries()) {
    if (expiry < now) {
      activeAdminSessions.delete(token);
    }
  }
}, 10 * 60 * 1000);

// Body parser with 50MB limit to handle matches with full ball-by-ball history, player photos & team logos
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS headers for PRISM Live webview, OBS browser sources, and iframe embedding
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// In-memory live matches cache for instant cross-device broadcast sync (PRISM Live Studio / OBS Studio)
const cachedMatches = new Map<string, any>();
let latestActiveMatch: any = null;

// Sync match state from scorer client
app.post('/api/matches/sync', (req: Request, res: Response) => {
  // Captain portal users are strictly restricted to squad management only!
  if (req.headers['x-captain-token'] || String(req.headers.authorization || '').includes('cpt_')) {
    return res.status(403).json({
      success: false,
      error: 'CAPTAIN_BLOCKED',
      message: 'Captains are strictly restricted to Squad Management only and cannot create or update matches.',
    });
  }
  const match = req.body;
  if (!match || !match.id) {
    return res.status(400).json({ error: 'Valid match object with id required' });
  }
  cachedMatches.set(match.id, match);
  if (
    match.status === 'LIVE' ||
    match.status === 'INNINGS_BREAK' ||
    match.status === 'PAUSED' ||
    latestActiveMatch?.id === match.id ||
    !latestActiveMatch
  ) {
    latestActiveMatch = match;
  }
  return res.json({ success: true, id: match.id });
});

// Get currently active live match
app.get('/api/matches/live', (_req: Request, res: Response) => {
  if (latestActiveMatch) {
    return res.json({ success: true, match: latestActiveMatch });
  }
  const all = Array.from(cachedMatches.values());
  const live =
    all.find((m) => m.status === 'LIVE' || m.status === 'INNINGS_BREAK' || m.status === 'PAUSED') ||
    all[0];
  return res.json({ success: true, match: live || null });
});

// Get cached match by ID
app.get('/api/matches/:id', (req: Request, res: Response) => {
  const match = cachedMatches.get(req.params.id);
  if (match) {
    return res.json({ success: true, match });
  }
  return res.status(404).json({ success: false, error: 'Match not found in cache' });
});

// Get all cached matches
app.get('/api/matches', (_req: Request, res: Response) => {
  return res.json({ success: true, matches: Array.from(cachedMatches.values()) });
});

// On-Demand AI Match Tactical Analysis Endpoint
app.post('/api/matches/analyze', async (req: Request, res: Response) => {
  try {
    const { match } = req.body || {};
    if (!match || !match.id) {
      return res.status(400).json({ success: false, error: 'Match data with valid id is required' });
    }

    if (!ai) {
      // Return 503 so client-side heuristic engine immediately handles generation
      return res.status(503).json({ success: false, message: 'Gemini AI not initialized on server, fallback available' });
    }

    const teamA = match.teamA?.name || 'Team A';
    const teamB = match.teamB?.name || 'Team B';
    const inn1 = match.innings1;
    const inn2 = match.innings2;

    // Identify 1st innings most expensive bowler and batter dot balls
    const inn1BowlersList = (inn1?.bowlers || []).map((bw: any) => ({
      name: bw.playerName,
      overs: String(bw.oversBowled || '1.0'),
      runsConceded: Number(bw.runsConceded || 0),
      wickets: Number(bw.wickets || 0),
      economy: Number(bw.economy || (bw.runsConceded && bw.legalBalls ? ((bw.runsConceded / bw.legalBalls) * 6).toFixed(1) : bw.runsConceded || 0)),
      maidens: Number(bw.maidens || 0),
      dots: Number(bw.dots || 0),
    })).sort((a: any, b: any) => b.runsConceded - a.runsConceded || b.economy - a.economy);

    const inn1MostExpensiveBowler = inn1BowlersList[0] || null;

    const allBalls = match.ballsHistory || [];

    const computeBatterDotsFromCommentary = (playerName: string, playerId: string, innNum: number, rawBallsFaced: number, rawDots?: number, fours = 0, sixes = 0) => {
      const norm = (playerName || '').trim().toLowerCase();
      const normWords = norm.split(/\s+/).filter(Boolean);

      const innBalls = allBalls.filter((b: any) => {
        if (b.inningsNumber != null && Number(b.inningsNumber) !== innNum) return false;
        if (b.extras && Number(b.extras.wides || 0) > 0) return false;
        const comm = (b.commentary || '').toLowerCase();
        if (comm.includes('wide')) return false;

        const bName = (b.batsmanName || '').trim().toLowerCase();
        const idMatch = b.batsmanId && b.batsmanId === playerId;
        const exactMatch = bName === norm;
        const subMatch = norm.length >= 3 && (bName.includes(norm) || norm.includes(bName));
        const wordMatch = normWords.length > 0 && normWords.some((w: string) => w.length >= 3 && bName.includes(w));
        return Boolean(idMatch || exactMatch || subMatch || wordMatch);
      });

      if (innBalls.length > 0) {
        let dots = 0;
        innBalls.forEach((b: any) => {
          const comm = (b.commentary || '').toLowerCase();
          const runsOffBat = Number(b.runsOffBat || 0);
          const byes = Number(b.extras?.byes || 0);
          const legByes = Number(b.extras?.legByes || 0);
          if (runsOffBat === 0 && byes === 0 && legByes === 0) {
            dots += 1;
          } else if ((comm.includes('0 run') || comm.includes('dot ball') || comm.includes('no run')) && byes === 0 && legByes === 0) {
            dots += 1;
          }
        });
        const bf = innBalls.length;
        const pct = bf > 0 ? Math.round((dots / bf) * 100) : 0;
        return { dotBalls: dots, ballsFaced: bf, dotBallPercentage: pct };
      }

      if (rawDots != null && rawDots > 0) {
        const pct = rawBallsFaced > 0 ? Math.round((rawDots / rawBallsFaced) * 100) : 0;
        return { dotBalls: rawDots, ballsFaced: rawBallsFaced, dotBallPercentage: pct };
      }

      const boundaries = (fours || 0) + (sixes || 0);
      const nonBoundary = Math.max(0, rawBallsFaced - boundaries);
      const estDots = Math.max(0, Math.round(nonBoundary * 0.4));
      const pct = rawBallsFaced > 0 ? Math.round((estDots / rawBallsFaced) * 100) : 0;
      return { dotBalls: estDots, ballsFaced: rawBallsFaced, dotBallPercentage: pct };
    };

    const inn1BattersList = (inn1?.batters || []).map((b: any) => {
      const dotStats = computeBatterDotsFromCommentary(
        b.playerName,
        b.playerId,
        1,
        Number(b.ballsFaced || 0),
        b.dotBalls,
        Number(b.fours || 0),
        Number(b.sixes || 0)
      );
      return {
        name: b.playerName,
        runs: Number(b.runs || 0),
        ballsFaced: dotStats.ballsFaced || Number(b.ballsFaced || 0),
        dotBalls: dotStats.dotBalls,
        dotBallPercentage: dotStats.dotBallPercentage,
        fours: Number(b.fours || 0),
        sixes: Number(b.sixes || 0),
        strikeRate: Number(b.strikeRate || 0),
        isOut: Boolean(b.isOut),
      };
    });

    const inn2BattersList = (inn2?.batters || []).map((b: any) => {
      const dotStats = computeBatterDotsFromCommentary(
        b.playerName,
        b.playerId,
        2,
        Number(b.ballsFaced || 0),
        b.dotBalls,
        Number(b.fours || 0),
        Number(b.sixes || 0)
      );
      return {
        name: b.playerName,
        runs: Number(b.runs || 0),
        ballsFaced: dotStats.ballsFaced || Number(b.ballsFaced || 0),
        dotBalls: dotStats.dotBalls,
        dotBallPercentage: dotStats.dotBallPercentage,
        fours: Number(b.fours || 0),
        sixes: Number(b.sixes || 0),
        strikeRate: Number(b.strikeRate || 0),
        isOut: Boolean(b.isOut),
      };
    });

    const inn1TotalDotsCalculated = inn1BattersList.reduce((acc: number, b: any) => acc + b.dotBalls, 0);
    const inn2TotalDotsCalculated = inn2BattersList.reduce((acc: number, b: any) => acc + b.dotBalls, 0);

    const inn2WicketsCount = inn2?.wickets || 0;
    const isSecondInningsWicketless = inn2 && inn2WicketsCount === 0;

    const matchStatsDigest = {
      matchId: match.id,
      tournament: match.tournamentName || 'Baryar Cricket League',
      venue: match.venue || 'Taif',
      format: match.matchFormat || 'T10',
      totalOvers: match.totalOvers || 10,
      resultText: match.result?.marginText || 'Match completed',
      winnerTeam: match.result?.winnerTeamName,
      potm: match.result?.playerOfTheMatch,
      criticalMatchIntegrityRules: {
        innings1ExactScore: `${inn1?.totalRuns || 0}/${inn1?.wickets || 0} in ${inn1?.overs || '0.0'} overs`,
        innings1WicketsFallen: inn1?.wickets || 0,
        innings1MostExpensiveBowler: inn1MostExpensiveBowler ? `${inn1MostExpensiveBowler.name} (${inn1MostExpensiveBowler.runsConceded} runs in ${inn1MostExpensiveBowler.overs} ov, Econ: ${inn1MostExpensiveBowler.economy})` : 'N/A',
        innings2ExactScore: inn2 ? `${inn2.totalRuns}/${inn2.wickets} in ${inn2.overs || '0.0'} overs` : 'N/A',
        innings2WicketsFallen: inn2 ? inn2.wickets : 0,
        isSecondInningsWicketless: isSecondInningsWicketless,
        founderNameUrdu: 'Suleman Baryar',
      },
      commentaryBoxDotBallAudit: {
        totalCommentaryBallsRecorded: allBalls.length,
        innings1BattersDotBalls: inn1BattersList.map((b: any) => `${b.name}: ${b.dotBalls} dot balls on ${b.ballsFaced} balls (${b.dotBallPercentage}%)`),
        innings2BattersDotBalls: inn2BattersList.map((b: any) => `${b.name}: ${b.dotBalls} dot balls on ${b.ballsFaced} balls (${b.dotBallPercentage}%)`),
        innings1TotalDots: inn1TotalDotsCalculated,
        innings2TotalDots: inn2TotalDotsCalculated,
      },
      innings1: {
        battingTeam: inn1?.battingTeamName || teamA,
        bowlingTeam: inn1?.bowlingTeamName || teamB,
        totalRuns: inn1?.totalRuns || 0,
        wickets: inn1?.wickets || 0,
        overs: inn1?.overs || `${(inn1?.legalBallsBowled || 0) / 6}`,
        extras: inn1?.extras?.total || 0,
        totalDotBalls: inn1TotalDotsCalculated,
        dotBallsPerOver: Number((inn1TotalDotsCalculated / Math.max(1, Number(inn1?.overs || 1))).toFixed(1)),
        mostExpensiveBowler: inn1MostExpensiveBowler,
        topBatters: inn1BattersList,
        topBowlers: inn1BowlersList,
      },
      innings2: inn2 ? {
        battingTeam: inn2.battingTeamName || teamB,
        bowlingTeam: inn2.bowlingTeamName || teamA,
        totalRuns: inn2.totalRuns || 0,
        wickets: inn2.wickets || 0,
        overs: inn2.overs || `${(inn2.legalBallsBowled || 0) / 6}`,
        extras: inn2.extras?.total || 0,
        totalDotBalls: inn2TotalDotsCalculated,
        dotBallsPerOver: Number((inn2TotalDotsCalculated / Math.max(1, Number(inn2?.overs || 1))).toFixed(1)),
        topBatters: inn2BattersList,
        topBowlers: (inn2.bowlers || []).map((bw: any) => ({
          name: bw.playerName,
          overs: bw.oversBowled,
          runsConceded: bw.runsConceded,
          wickets: bw.wickets,
          economy: bw.economy,
          maidens: bw.maidens,
          dots: bw.dots || 0,
        })),
      } : null,
    };

    const prompt = `You are a Senior Professional Cricket Tactical Analyst for the Baryar Cricket League.
Analyze the following match statistics with special emphasis on First Innings breakdown, Dot Ball Impact Analysis, strike rotation, pressure overs, bowler effectiveness, and chase escalation.

IMPORTANT LANGUAGE & INTEGRITY SPECIFICATIONS:
1. Headings and JSON keys MUST BE in English.
2. All analytical descriptions, explanations, tactical reasons, commentary, and summaries MUST BE in fluent, high-quality ROMAN ENGLISH (Roman Urdu / Latin script transliteration, e.g. "Pehli innings mein Chawinda 11 ne 6 overs mein 117/1 score kiya...").
   CRITICAL REASON: Do NOT use Arabic/Urdu unicode script characters (اردو رسم الخط استعمال نہ کریں) because PDF export breaks and scrambles non-Latin fonts. Everything must be written in readable Roman English.
3. FOUNDER NAME: Write strictly "Suleman Baryar" (e.g. "Suleman Baryar Khiraj-e-Tehseen: Baryar Cricket ke baani aur visionary leader Suleman Baryar sb ki...").
4. BOWLER EFFECTIVENESS & NEGATIVE IMPACT BOWLER SELECTION:
   - Carefully evaluate the economy rate and run leakage per over.
   - If a bowler conceded 31 runs in 1 over (economy 31.00), that 31-run over was catastrophic and caused far more damage to the team than a bowler who bowled 2 overs for 42 runs (economy 21.00).
   - The negative impact player MUST BE the bowler who leaked runs at the highest, most damaging rate (e.g. Abubakar with 31 runs in 1 over), NOT a bowler who bowled more overs at a lower economy!
5. MATCH-WINNING INNINGS:
   - Identify which batter played the decisive match-winning innings with high strike rate and boundary hitting.
6. FIRST INNINGS & BOTH TEAMS' MANDATORY COMPARISON:
   In executiveSummary, turningPoints, and firstInningsAnalysis, you MUST clearly state:
   - What was the exact first innings score, how many wickets fell, and in how many overs (e.g. 117/1 in 6.0 overs at 19.50 RPO).
   - Which bowler bowled the most expensive over / spell (e.g. Abubakar conceding 31 runs in 1 over).
   - Both teams' total dot balls and dot ball percentage.
   - Both teams' total boundaries (4s and 6s) and boundary runs.
   - How the chase concluded (e.g. BCC scoring 114 at 19.00 RPO, falling short by just 3 runs).
7. Ground every observation in the actual provided numbers. NEVER invent statistics.

Match Data:
${JSON.stringify(matchStatsDigest, null, 2)}

Required JSON Schema:
{
  "executiveSummary": "2-3 clear sentences in Roman English explicitly mentioning first innings score and wickets, chase score and outcome, and tactical factors.",
  "winningTeamFactors": ["Factor 1 in Roman English (mentioning match winning innings and boundary count)", "Factor 2 in Roman English", "Factor 3 in Roman English"],
  "losingTeamFactors": ["Deficit 1 in Roman English (mentioning the most expensive 31-run over and bowler)", "Deficit 2 in Roman English (mentioning dot balls in chase)", "Deficit 3 in Roman English"],
  "topPerformers": {
    "batters": [
      { "name": "...", "team": "...", "stat": "45 runs (22b, SR: 204.5)", "impact": "Impact description in Roman English (e.g. Match winning innings with 4s and 6s)" }
    ],
    "bowlers": [
      { "name": "...", "team": "...", "stat": "3/14 (2.0 ov, Econ: 7.0)", "impact": "Impact description in Roman English" }
    ]
  },
  "turningPoints": [
    "Turning point 1 in Roman English: Pehli innings score, wickets and run rate",
    "Turning point 2 in Roman English: Sab se mehnga over (e.g. Abubakar conceding 31 runs in 1 over)",
    "Turning point 3 in Roman English: Match-winning innings by top batter",
    "Turning point 4 in Roman English: Dot balls and boundaries comparison between both teams",
    "Turning point 5 in Roman English: Final chase verdict (e.g. 114 runs scored, losing by just 3 runs)"
  ],
  "mvpPlayer": {
    "playerName": "...",
    "teamName": "...",
    "role": "BATTER",
    "keyStats": "...",
    "impactType": "POSITIVE_MVP",
    "tacticalReason": "Tactical reason in Roman English explaining decisive match winning contribution"
  },
  "negativeImpactPlayer": {
    "playerName": "...",
    "teamName": "...",
    "role": "BOWLER",
    "keyStats": "...",
    "impactType": "NEGATIVE_IMPACT",
    "tacticalReason": "Tactical reason in Roman English accurately identifying the most expensive bowler (e.g. 31 runs in 1 over) as the primary damage factor"
  },
  "firstInningsAnalysis": {
    "battingTeam": "Team 1 Name",
    "bowlingTeam": "Team 2 Name",
    "totalRuns": 0,
    "wickets": 0,
    "overs": "0.0",
    "runRate": "0.00",
    "scoreSummaryUrdu": "Pehli innings mein Team 1 ne X overs mein Y runs banaye aur Z wickets giri (Run Rate: RPO).",
    "mostExpensiveBowler": {
      "name": "Bowler Name",
      "overs": "1.0",
      "runsConceded": 0,
      "wickets": 0,
      "economy": 0.0,
      "descriptionUrdu": "Bowler Name ne 1 over mein 31 runs diye jo innings ka sab se mehnga over sabit hua."
    },
    "batterDotBalls": [
      {
        "name": "Batter Name",
        "runs": 0,
        "ballsFaced": 0,
        "dotBalls": 0,
        "dotBallPercentage": 0
      }
    ]
  },
  "statisticalEvidence": {
    "runRateComparison": "Team1: X RPO vs Team2: Y RPO",
    "dotBallFactor": "Dot balls comparison in Roman English",
    "boundaryComparison": "Team1: X boundaries vs Team2: Y boundaries",
    "extrasImpact": "Extras comparison"
  },
  "dotBallAnalysis": {
    "mostDotBallsBatter": {
      "name": "Batter with highest dot balls",
      "team": "Team",
      "dotBalls": 0,
      "ballsFaced": 0,
      "dotBallPercentage": 0,
      "runsScored": 0,
      "impactDescriptionUrdu": "Detailed impact of their dot balls in Roman English"
    },
    "pressureOvers": [
      {
        "overNumber": 1,
        "bowlerName": "Bowler Name",
        "dotBalls": 3,
        "runsConceded": 4,
        "wickets": 1,
        "pressureDescriptionUrdu": "How this over built immense dot ball pressure in Roman English"
      }
    ],
    "chaseDotImpact": {
      "targetRuns": 0,
      "initialRRR": 0,
      "finalRRR": 0,
      "chaseTotalDots": 0,
      "chaseDotPercentage": 0,
      "estimatedRunsLost": 0,
      "chaseDefeatFactorUrdu": "How dot balls increased required run rate and affected the chase in Roman English"
    },
    "overallVerdictUrdu": "Comprehensive Roman English tactical conclusion on dot balls and strike rotation"
  },
  "sulemanBaryarTribute": "Suleman Baryar Khiraj-e-Tehseen: Baryar Cricket ke baani aur visionary leader Suleman Baryar sb ki grassroots cricket ke liye be-misaal khidmaat, sportsman spirit aur dedicated leadership ko khiraj-e-tehseen paish kiya jata hai."
}

Respond ONLY with valid JSON. Do not include markdown code block backticks if possible, or wrap in \`\`\`json ... \`\`\`.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const rawText = response.text || '';
    const cleanedText = rawText.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
    const parsedAnalysis = JSON.parse(cleanedText);

    // Ensure all critical fields exist
    parsedAnalysis.matchId = match.id;
    parsedAnalysis.generatedAt = new Date().toISOString();
    parsedAnalysis.matchTitle = `${teamA} vs ${teamB}`;
    parsedAnalysis.resultSummary = match.result?.marginText || parsedAnalysis.resultSummary || 'Match Concluded';

    return res.json({
      success: true,
      analysis: parsedAnalysis,
    });
  } catch (error: any) {
    console.warn('[AI Match Analysis API Error]:', error?.message || error);
    return res.status(500).json({
      success: false,
      error: 'Failed to generate AI analysis on server',
      details: error?.message,
    });
  }
});

// Friendly redirect routes for overlay and scorecard
app.get('/overlay', (req: Request, res: Response) => {
  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const glue = qs ? (qs.includes('view=') ? '' : '&view=overlay') : '?view=overlay';
  res.redirect(`/${qs}${glue}`);
});

app.get('/scoreboard', (req: Request, res: Response) => {
  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const glue = qs ? (qs.includes('view=') ? '' : '&view=scorecard') : '?view=scorecard';
  res.redirect(`/${qs}${glue}`);
});


// Helper: Timing-safe string comparison to protect against timing attacks
function safeCompare(input: string, secret: string): boolean {
  try {
    const inputBuf = Buffer.from(input, 'utf8');
    const secretBuf = Buffer.from(secret, 'utf8');
    if (inputBuf.length !== secretBuf.length) {
      // Do a dummy timing comparison with same length to prevent timing leaks
      crypto.timingSafeEqual(secretBuf, secretBuf);
      return false;
    }
    return crypto.timingSafeEqual(inputBuf, secretBuf);
  } catch {
    return false;
  }
}

// 1. Admin Login Endpoint
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { password } = req.body || {};

  if (!password || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'Password is required' });
  }

  const isValid = safeCompare(password.trim(), ADMIN_PASSWORD);

  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: 'Invalid Administrator Password. Access denied.',
    });
  }

  // Generate secure 32-byte hex session token
  const token = crypto.randomBytes(32).toString('hex');
  // 24 hours expiry
  const expiry = Date.now() + 24 * 60 * 60 * 1000;
  activeAdminSessions.set(token, expiry);

  res.setHeader(
    'Set-Cookie',
    `baryar_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
  );

  return res.json({
    success: true,
    token,
    email: ADMIN_EMAIL,
    expiresAt: expiry,
  });
});

// 2. Admin Session Status Check Endpoint
app.get('/api/admin/session', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(/baryar_admin_session=([a-f0-9]+)/);
    if (match) token = match[1];
  }

  if (!token) {
    return res.json({ isAuthenticated: false });
  }

  const expiry = activeAdminSessions.get(token);
  if (!expiry || expiry < Date.now()) {
    activeAdminSessions.delete(token);
    return res.json({ isAuthenticated: false });
  }

  return res.json({
    isAuthenticated: true,
    user: {
      role: 'admin',
      email: ADMIN_EMAIL,
    },
  });
});

// 3. Admin Logout Endpoint
app.post('/api/admin/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(/baryar_admin_session=([a-f0-9]+)/);
    if (match) token = match[1];
  }

  if (token) {
    activeAdminSessions.delete(token);
  }

  res.setHeader(
    'Set-Cookie',
    `baryar_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  );

  return res.json({ success: true });
});

// ============================================================================
// BARYAR CRICKET MULTI-SCORER SYSTEM (Server Authority & Real-Time Sync)
// ============================================================================

interface ServerScorerKey {
  id: string;
  key: string;
  keyHash: string;
  scorerName: string;
  assignedTournamentId: string;
  assignedTournamentName: string;
  assignedMatchIds?: string[];
  expiryDate: string;
  status: 'ACTIVE' | 'DEACTIVATED' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  createdBy: string;
  lastLoginAt?: string;
  lastActiveAt?: string;
  lastActiveMatchId?: string;
  lastActiveMatchTitle?: string;
  ballsScoredCount?: number;
}

const SCORER_BACKUP_FILE = path.join(__dirname, 'data', 'scorer_keys_backup.json');
const serverScorerKeys = new Map<string, ServerScorerKey>();
const activeScorerTokens = new Map<string, { scorerId: string; expiresAt: number }>();

function loadScorerKeysFromDisk() {
  try {
    if (fs.existsSync(SCORER_BACKUP_FILE)) {
      const raw = fs.readFileSync(SCORER_BACKUP_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        list.forEach((s) => {
          if (s && s.id) serverScorerKeys.set(s.id, s);
        });
      }
    }
  } catch (err) {
    console.warn('[Server Storage] Warning loading scorer keys disk backup:', err);
  }
}

function saveScorerKeysToDisk() {
  try {
    const backupDir = path.join(__dirname, 'data');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const list = Array.from(serverScorerKeys.values());
    fs.writeFileSync(SCORER_BACKUP_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Server Storage] Warning saving scorer keys disk backup:', err);
  }
}

// Initial load on boot
loadScorerKeysFromDisk();

function normalizeKey(raw: string): string {
  return (raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

function hashKeyServer(raw: string): string {
  const clean = normalizeKey(raw);
  return crypto.createHash('sha256').update(clean).digest('hex');
}

// 1. Get all scorer keys (Admin only)
app.get('/api/admin/scorers', (req: Request, res: Response) => {
  const isAuth = isRequestAdminAuthorized(req);
  // Also allow if running in development mode
  if (!isAuth && IS_PROD) {
    return res.status(401).json({ success: false, error: 'Unauthorized Super Admin access' });
  }
  return res.json({
    success: true,
    scorers: Array.from(serverScorerKeys.values()),
  });
});

// 2. Create or update scorer key (Admin only)
app.post('/api/admin/scorers', (req: Request, res: Response) => {
  const isAuth = isRequestAdminAuthorized(req);
  if (!isAuth && IS_PROD) {
    return res.status(401).json({ success: false, error: 'Unauthorized Super Admin access' });
  }

  const data = req.body as ServerScorerKey;
  if (!data || !data.key || !data.scorerName) {
    return res.status(400).json({ success: false, error: 'Key and scorerName are required' });
  }

  const cleanKey = normalizeKey(data.key);
  const keyHash = data.keyHash || hashKeyServer(cleanKey);
  const id = data.id || keyHash;

  const doc: ServerScorerKey = {
    ...data,
    id,
    key: cleanKey,
    keyHash,
    status: data.status || 'ACTIVE',
    createdAt: data.createdAt || new Date().toISOString(),
    createdBy: data.createdBy || 'Suleman Baryar (Super Admin)',
    ballsScoredCount: data.ballsScoredCount || 0,
  };

  serverScorerKeys.set(id, doc);
  saveScorerKeysToDisk();
  return res.json({ success: true, scorer: doc });
});

// 3. Update scorer key status (Admin only)
app.patch('/api/admin/scorers/:id', (req: Request, res: Response) => {
  const isAuth = isRequestAdminAuthorized(req);
  if (!isAuth && IS_PROD) {
    return res.status(401).json({ success: false, error: 'Unauthorized Super Admin access' });
  }

  const { id } = req.params;
  const existing = serverScorerKeys.get(id);
  if (!existing) {
    // If not in server memory yet, create minimal record
    const updated: ServerScorerKey = {
      id,
      key: '',
      keyHash: id,
      scorerName: 'Scorer',
      assignedTournamentId: '',
      assignedTournamentName: '',
      expiryDate: new Date(Date.now() + 7 * 86400000).toISOString(),
      status: req.body?.status || 'ACTIVE',
      createdAt: new Date().toISOString(),
      createdBy: 'Super Admin',
      ...req.body,
    };
    serverScorerKeys.set(id, updated);
    saveScorerKeysToDisk();
    return res.json({ success: true, scorer: updated });
  }

  const updated = { ...existing, ...req.body };
  serverScorerKeys.set(id, updated);
  saveScorerKeysToDisk();
  return res.json({ success: true, scorer: updated });
});

// 4. Delete scorer key (Admin only)
app.delete('/api/admin/scorers/:id', (req: Request, res: Response) => {
  const isAuth = isRequestAdminAuthorized(req);
  if (!isAuth && IS_PROD) {
    return res.status(401).json({ success: false, error: 'Unauthorized Super Admin access' });
  }

  const { id } = req.params;
  serverScorerKeys.delete(id);
  saveScorerKeysToDisk();

  // Invalidate any active sessions for this scorer
  for (const [token, session] of activeScorerTokens.entries()) {
    if (session.scorerId === id) {
      activeScorerTokens.delete(token);
    }
  }

  return res.json({ success: true, deletedId: id });
});

// 5. Scorer Key Verification Endpoint (Key-based Scorer Login)
app.post('/api/scorers/verify-key', (req: Request, res: Response) => {
  const { key, keyHash } = req.body || {};
  if (!key && !keyHash) {
    return res.status(400).json({ success: false, error: 'Scorer key is required.' });
  }

  const cleanKey = normalizeKey(key || '');
  const computedHash = keyHash || (cleanKey ? hashKeyServer(cleanKey) : '');

  // Look up in server memory
  let matched: ServerScorerKey | undefined;
  for (const doc of serverScorerKeys.values()) {
    if (
      normalizeKey(doc.key) === cleanKey ||
      doc.keyHash === computedHash ||
      doc.id === computedHash
    ) {
      matched = doc;
      break;
    }
  }

  if (!matched) {
    return res.status(401).json({
      success: false,
      notInServerMemory: true,
      error: 'Scorer Key not found in server cache. Verifying with primary database...',
    });
  }

  // Check status
  if (matched.status === 'REVOKED') {
    return res.status(403).json({
      success: false,
      error: 'Access Revoked! Super Admin ne is Scorer Key ko revoke kar diya hai.',
    });
  }
  if (matched.status === 'DEACTIVATED') {
    return res.status(403).json({
      success: false,
      error: 'Key Deactivated! Super Admin se access dobara activate karwayen.',
    });
  }

  // Check expiry
  const now = Date.now();
  const expiry = new Date(matched.expiryDate).getTime();
  if (!isNaN(expiry) && expiry < now) {
    matched.status = 'EXPIRED';
    return res.status(403).json({
      success: false,
      error: 'Scorer Key Expired! Is key ki meyad khatam ho chuki hai. Nayi key hasil karein.',
    });
  }

  // Generate revocable session token
  const token = 'stk_' + crypto.randomBytes(24).toString('hex');
  activeScorerTokens.set(token, { scorerId: matched.id, expiresAt: expiry });

  // Update last login
  matched.lastLoginAt = new Date().toISOString();
  matched.lastActiveAt = new Date().toISOString();

  const session = {
    token,
    scorerId: matched.id,
    scorerName: matched.scorerName,
    key: matched.key,
    assignedTournamentId: matched.assignedTournamentId,
    assignedTournamentName: matched.assignedTournamentName,
    assignedMatchIds: matched.assignedMatchIds || [],
    expiresAt: matched.expiryDate,
  };

  return res.json({ success: true, session });
});

// 6. Scorer Heartbeat & Scoring Activity
app.post('/api/scorers/activity', (req: Request, res: Response) => {
  const { scorerId, matchId, matchTitle } = req.body || {};
  if (!scorerId) {
    return res.json({ success: true });
  }

  const doc = serverScorerKeys.get(scorerId);
  if (doc) {
    doc.lastActiveAt = new Date().toISOString();
    if (matchId) doc.lastActiveMatchId = matchId;
    if (matchTitle) doc.lastActiveMatchTitle = matchTitle;
    doc.ballsScoredCount = (doc.ballsScoredCount || 0) + 1;
  }
  return res.json({ success: true });
});

// 7. Scorer Logout
app.post('/api/scorers/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    activeScorerTokens.delete(token);
  }
  return res.json({ success: true });
});

// ============================================================================
// DYNAMIC TOURNAMENT TEAM REGISTRATION PORTAL (Server-Side Authority & Lock)
// ============================================================================

interface ServerTournamentRegistration {
  tournamentId: string;
  tournamentName: string;
  startDate: string;
  registrationSettings?: {
    enabled?: boolean;
    lockDeadlineIso?: string;
    lockOverride?: boolean;
    minSquadSize?: number;
    maxSquadSize?: number;
  };
  participatingTeams: Array<{
    id: string;
    name: string;
    logoUrl?: string;
    group?: string;
  }>;
  teamRegistrations: Record<
    string,
    {
      teamId: string;
      teamName: string;
      authCode: string;
      isClaimed: boolean;
      claimedByCaptainName?: string;
      claimedByCaptainPhone?: string;
      claimedAt?: string;
      logoUrl?: string;
      squad?: any[];
      lastUpdatedAt?: string;
    }
  >;
}

// In-memory cache for fast validation & synchronization
const serverTournamentsRegCache = new Map<string, ServerTournamentRegistration>();

/**
 * Computes exact 10:00 PM Asia/Riyadh (UTC+3) on the day before tournament start date.
 */
function computeRiyadhRegistrationLockDeadlineServer(startDateStr: string): string {
  if (!startDateStr || typeof startDateStr !== 'string') {
    return new Date(Date.now() + 7 * 86400000).toISOString();
  }
  const clean = startDateStr.trim().split('T')[0];
  const parts = clean.split('-').map(Number);
  if (parts.length < 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) {
    return new Date(Date.now() + 7 * 86400000).toISOString();
  }
  const [year, month, day] = parts;
  // Day before start date
  const targetDay = new Date(Date.UTC(year, month - 1, day - 1, 0, 0, 0));
  const tYear = targetDay.getUTCFullYear();
  const tMonth = targetDay.getUTCMonth();
  const tDate = targetDay.getUTCDate();
  // 10:00 PM (22:00) Asia/Riyadh (UTC+3) is 19:00:00 UTC
  const deadlineUtc = new Date(Date.UTC(tYear, tMonth, tDate, 19, 0, 0));
  return deadlineUtc.toISOString();
}

/**
 * Checks whether registration is strictly locked on the server.
 */
function isRegistrationLockedServer(regData: ServerTournamentRegistration): {
  isLocked: boolean;
  reason: string;
  deadlineIso: string;
} {
  const settings = regData.registrationSettings;
  if (settings?.enabled === false) {
    return { isLocked: true, reason: 'Registration disabled by Admin', deadlineIso: '' };
  }
  if (settings?.lockOverride) {
    return { isLocked: false, reason: 'Super Admin Override Active', deadlineIso: '' };
  }

  // Captain squad registration remains open whenever enabled !== false
  const deadlineIso =
    settings?.lockDeadlineIso || computeRiyadhRegistrationLockDeadlineServer(regData.startDate);

  return { isLocked: false, reason: 'Open', deadlineIso };
}
// Persistent server storage for tournaments management (in-memory + disk backup)
const BACKUP_DIR = path.join(__dirname, 'data');
const BACKUP_FILE = path.join(BACKUP_DIR, 'tournaments_mgmt_backup.json');
const PLAYERS_BACKUP_FILE = path.join(BACKUP_DIR, 'master_players_backup.json');

const serverTournamentsMgmt = new Map<string, any>();
const serverMasterPlayers = new Map<string, any>();

function normalizePlayerNameServer(name: string): string {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function getPlayerIdentityIdServer(player: { id?: string; name: string }): string {
  const norm = (player.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = (hash << 5) - hash + norm.charCodeAt(i);
    hash |= 0;
  }
  const positive = Math.abs(hash) % 10000;
  return `BC-PL-${positive.toString().padStart(4, '0')}`;
}

function generatePlayerIdServer(name: string): string {
  const clean = (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean || `player_${Date.now()}`;
}

function indexServerPlayer(p: any, primaryTeamName?: string) {
  if (!p || !p.name || typeof p.name !== 'string') return null;
  const cleanName = p.name.trim();
  if (cleanName.length < 2) return null;
  const normKey = normalizePlayerNameServer(cleanName);
  if (!normKey) return null;

  const canonicalId = p.id && !p.id.startsWith('tsp_') ? p.id : generatePlayerIdServer(cleanName);
  const identityId = p.identityId || p.cnicOrId || getPlayerIdentityIdServer({ id: canonicalId, name: cleanName });

  const existing = serverMasterPlayers.get(normKey);
  const updated = {
    id: existing?.id || canonicalId,
    identityId: existing?.identityId || identityId,
    name: existing?.name || cleanName,
    role: p.role || existing?.role || 'All-Rounder',
    battingStyle: p.battingStyle || existing?.battingStyle || 'Right-hand Bat',
    bowlingStyle: p.bowlingStyle || existing?.bowlingStyle || 'Right-arm Medium',
    jerseyNumber: p.jerseyNumber || existing?.jerseyNumber,
    photoUrl: p.photoUrl || existing?.photoUrl || '',
    primaryTeam: p.primaryTeam || existing?.primaryTeam || primaryTeamName || '',
    mobile: p.mobile || existing?.mobile || '',
    careerMatches: Math.max(existing?.careerMatches || 0, p.careerMatches || 0),
    careerRuns: Math.max(existing?.careerRuns || 0, p.careerRuns || 0),
    careerWickets: Math.max(existing?.careerWickets || 0, p.careerWickets || 0),
    careerHighestScore: existing?.careerHighestScore || p.careerHighestScore || 0,
    careerBestBowling: existing?.careerBestBowling || p.careerBestBowling || '—',
    motmAwards: Math.max(existing?.motmAwards || 0, p.motmAwards || 0),
    updatedAt: new Date().toISOString(),
  };

  serverMasterPlayers.set(normKey, updated);
  return updated;
}

function loadMasterPlayersFromDisk() {
  try {
    if (fs.existsSync(PLAYERS_BACKUP_FILE)) {
      const raw = fs.readFileSync(PLAYERS_BACKUP_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        list.forEach((p) => {
          if (p && p.name) indexServerPlayer(p);
        });
      }
    }
  } catch (err) {
    console.warn('[Server Storage] Warning loading master players backup:', err);
  }
}

function saveMasterPlayersToDisk() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const list = Array.from(serverMasterPlayers.values());
    fs.writeFileSync(PLAYERS_BACKUP_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Server Storage] Warning saving master players backup:', err);
  }
}

function isBccOrBaryarAliasServer(str?: string | null): boolean {
  if (!str) return false;
  const norm = str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return false;
  return (
    norm === 'bcc' ||
    norm === 'baryar' ||
    norm === 'baryarcricketclub' ||
    norm === 'baryarcc' ||
    norm === 'baryarcricket' ||
    norm === 'baryarclub' ||
    norm.includes('baryarcricketclub') ||
    norm.includes('baryarcc') ||
    norm.startsWith('baryar') && !norm.includes('premier') && !norm.includes('chawinda')
  );
}

function loadTournamentsFromDisk() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        list.forEach((t) => {
          if (t && t.id) {
            // Canonicalize Baryar Cricket Club into BCC
            if (t.teamRegistrations) {
              const baryarReg = t.teamRegistrations['baryar_cricket_club'];
              const bccReg = t.teamRegistrations['bcc'];
              if (baryarReg) {
                t.teamRegistrations['bcc'] = {
                  ...baryarReg,
                  ...(bccReg || {}),
                  teamId: 'bcc',
                  teamName: 'BCC',
                  squad: (bccReg?.squad && bccReg.squad.length > 0) ? bccReg.squad : (baryarReg.squad || []),
                  logoUrl: bccReg?.logoUrl || baryarReg.logoUrl || '',
                };
                delete t.teamRegistrations['baryar_cricket_club'];
              } else if (bccReg && isBccOrBaryarAliasServer(bccReg.teamName)) {
                bccReg.teamName = 'BCC';
              }
            }

            // Deduplicate and canonicalize participating teams and team IDs
            if (Array.isArray(t.participatingTeams)) {
              const seen = new Set();
              t.participatingTeams = t.participatingTeams
                .map((pt: any) => {
                  if (isBccOrBaryarAliasServer(pt.id) || isBccOrBaryarAliasServer(pt.name)) {
                    return { ...pt, id: 'bcc', name: 'BCC' };
                  }
                  return pt;
                })
                .filter((pt: any) => {
                  const k = (pt.id || pt.name || '').trim().toLowerCase();
                  if (!k || seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
            }
            if (Array.isArray(t.participatingTeamIds)) {
              t.participatingTeamIds = Array.from(
                new Set(
                  t.participatingTeamIds.map((id: string) =>
                    isBccOrBaryarAliasServer(id) ? 'bcc' : id
                  )
                )
              );
            }

            // Index all players in team registrations to master player store
            if (t.teamRegistrations) {
              Object.values(t.teamRegistrations).forEach((reg: any) => {
                if (Array.isArray(reg?.squad)) {
                  reg.squad.forEach((sp: any) => {
                    if (sp && sp.name) {
                      indexServerPlayer(sp, reg.teamName);
                    }
                  });
                }
              });
            }

            serverTournamentsMgmt.set(t.id, t);
            serverTournamentsRegCache.set(t.id, {
              tournamentId: t.id,
              tournamentName: t.name || t.tournamentName || 'Tournament',
              startDate: t.startDate || '',
              registrationSettings: t.registrationSettings,
              participatingTeams: t.participatingTeams || [],
              teamRegistrations: t.teamRegistrations || {},
            });
          }
        });
      }
    }
  } catch (err) {
    console.warn('[Server Storage] Warning loading disk tournaments backup:', err);
  }
}

function saveTournamentsToDisk() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const list = Array.from(serverTournamentsMgmt.values());
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Server Storage] Warning saving disk tournaments backup:', err);
  }
}

// Active Captain Sessions (token -> CaptainSession)
interface CaptainSession {
  token: string;
  tournamentId: string;
  teamId: string;
  authCode: string;
  teamName: string;
  captainName?: string;
  expiresAt: number;
}
const activeCaptainSessions = new Map<string, CaptainSession>();

function getCaptainSession(req: Request): CaptainSession | null {
  const authHeader = req.headers.authorization;
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token && typeof req.query.token === 'string') token = req.query.token;
  if (!token && req.body && typeof req.body.token === 'string') token = req.body.token;
  if (!token && req.headers['x-captain-token']) token = String(req.headers['x-captain-token']);
  if (!token) return null;
  const session = activeCaptainSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    activeCaptainSessions.delete(token);
    return null;
  }
  return session;
}

// Initial loads on boot
loadMasterPlayersFromDisk();
loadTournamentsFromDisk();
saveMasterPlayersToDisk();

// Helper for loose matching of tournament names on server
function isTournamentNameMatchServer(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const cleanA = a.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const cleanB = b.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  return cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA);
}

// Helper: Extract and validate authorized Scorer Key session from request
function getScorerSessionFromReq(req: Request): ServerScorerKey | null {
  const authHeader = req.headers.authorization;
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token && typeof req.query.scorerToken === 'string') token = req.query.scorerToken;
  if (!token && req.body && typeof req.body.scorerToken === 'string') token = req.body.scorerToken;
  if (!token && req.headers['x-scorer-token']) token = String(req.headers['x-scorer-token']);
  if (!token && typeof req.query.token === 'string' && req.query.token.startsWith('stk_')) token = req.query.token;
  if (!token && req.body && typeof req.body.token === 'string' && req.body.token.startsWith('stk_')) token = req.body.token;

  if (!token || !token.startsWith('stk_')) return null;

  const session = activeScorerTokens.get(token);
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < Date.now()) {
    activeScorerTokens.delete(token);
    return null;
  }

  const scorerDoc = serverScorerKeys.get(session.scorerId);
  if (!scorerDoc || scorerDoc.status === 'REVOKED' || scorerDoc.status === 'DEACTIVATED') {
    return null;
  }

  return scorerDoc;
}

interface TournamentAuthResult {
  authorized: boolean;
  role: 'admin' | 'scorer' | null;
  reason?: string;
  scorerName?: string;
}

// Global Tournament Access Verification:
// - Admin password bypasses lock
// - Appointed Scorer can ONLY access their assigned tournament
// - Captain Portal users are strictly blocked from full tournament access
// - All other requests remain locked by default requiring Admin password
function checkTournamentAccessAuth(req: Request, tournamentId: string): TournamentAuthResult {
  // 1. Captains are strictly blocked from full tournament access
  const captainSession = getCaptainSession(req);
  const authHeader = req.headers.authorization;
  const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (captainSession || (rawToken && rawToken.startsWith('cpt_')) || req.headers['x-captain-token']) {
    return {
      authorized: false,
      role: null,
      reason: 'CAPTAIN_PORTAL_BLOCKED: Captains are strictly restricted to Squad Management only and cannot open full tournaments.',
    };
  }

  // 2. Admin verification (Token, Cookie, or Header/Body direct password)
  if (isRequestAdminAuthorized(req)) {
    return { authorized: true, role: 'admin' };
  }

  // 3. Scorer verification: Only allowed if assigned to this exact tournament
  const scorer = getScorerSessionFromReq(req);
  if (scorer) {
    const tourn = serverTournamentsMgmt.get(tournamentId);
    const assignedId = scorer.assignedTournamentId;
    const assignedName = scorer.assignedTournamentName;

    const idMatch = Boolean(
      assignedId &&
      (assignedId === tournamentId || tournamentId.includes(assignedId) || assignedId.includes(tournamentId))
    );
    const nameMatch = Boolean(
      assignedName && tourn && isTournamentNameMatchServer(tourn.name, assignedName)
    );

    if (idMatch || nameMatch) {
      return {
        authorized: true,
        role: 'scorer',
        scorerName: scorer.scorerName,
      };
    } else {
      return {
        authorized: false,
        role: null,
        reason: 'SCORER_UNAUTHORIZED_TOURNAMENT: You are only authorized to access your Admin-assigned tournament.',
      };
    }
  }

  // 4. Default: Locked for everyone else!
  return {
    authorized: false,
    role: null,
    reason: 'ADMIN_PASSWORD_REQUIRED: Tournament Open is locked. Super Admin password or authorized Scorer Key is required.',
  };
}

// Tournaments Management Endpoints
app.get('/api/tournaments-mgmt', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    tournaments: Array.from(serverTournamentsMgmt.values()),
  });
});

// Dedicated verify-access endpoint for Tournament Open verification
app.post('/api/tournaments-mgmt/:tournamentId/verify-access', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  const tourn = serverTournamentsMgmt.get(tournamentId);
  if (!tourn) {
    return res.status(404).json({ success: false, error: 'Tournament not found' });
  }

  const auth = checkTournamentAccessAuth(req, tournamentId);
  if (auth.authorized) {
    return res.json({
      success: true,
      authorized: true,
      role: auth.role,
      scorerName: auth.scorerName,
      tournament: tourn,
    });
  }

  return res.status(403).json({
    success: false,
    authorized: false,
    error: auth.reason || 'ADMIN_PASSWORD_REQUIRED',
    message: 'Tournament Open/View is locked by default. Verification required.',
  });
});

// Secure Tournament Fetch: Rejects unauthorized requests
app.get('/api/tournaments-mgmt/:tournamentId', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  const tourn = serverTournamentsMgmt.get(tournamentId);
  if (!tourn) {
    return res.status(404).json({ success: false, error: 'Tournament not found on server' });
  }

  // Enforce access verification:
  const auth = checkTournamentAccessAuth(req, tournamentId);
  if (!auth.authorized) {
    return res.status(403).json({
      success: false,
      error: 'TOURNAMENT_LOCKED',
      reason: auth.reason,
      locked: true,
      id: tourn.id,
      name: tourn.name,
      status: tourn.status,
    });
  }

  return res.json({ success: true, tournament: tourn, role: auth.role });
});

app.post('/api/tournaments-mgmt', (req: Request, res: Response) => {
  // Strictly block Captains and unverified users from modifying or creating full tournaments
  if (!isRequestAdminAuthorized(req)) {
    return res.status(403).json({
      success: false,
      error: 'ADMIN_REQUIRED',
      message: 'Access Denied: Super Admin privileges are required to create or manage full tournaments. Captains are restricted to squad management.',
    });
  }

  const payload = req.body;
  if (!payload || !payload.id) {
    return res.status(400).json({ success: false, error: 'Tournament id and data required' });
  }

  // Deduplicate participating teams and team IDs
  if (Array.isArray(payload.participatingTeams)) {
    const seen = new Set();
    payload.participatingTeams = payload.participatingTeams.filter((pt: any) => {
      const k = (pt.id || pt.name || '').trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (Array.isArray(payload.participatingTeamIds)) {
    payload.participatingTeamIds = Array.from(new Set(payload.participatingTeamIds));
  }

  serverTournamentsMgmt.set(payload.id, payload);
  // Also sync to registration cache
  serverTournamentsRegCache.set(payload.id, {
    tournamentId: payload.id,
    tournamentName: payload.name || payload.tournamentName || 'Tournament',
    startDate: payload.startDate || '',
    registrationSettings: payload.registrationSettings,
    participatingTeams: payload.participatingTeams || [],
    teamRegistrations: payload.teamRegistrations || {},
  });
  saveTournamentsToDisk();
  return res.json({ success: true, tournament: payload });
});

app.delete('/api/tournaments-mgmt/:tournamentId', (req: Request, res: Response) => {
  if (!isRequestAdminAuthorized(req)) {
    return res.status(403).json({
      success: false,
      error: 'ADMIN_REQUIRED',
      message: 'Access Denied: Super Admin privileges are required to delete tournaments.',
    });
  }

  const { tournamentId } = req.params;
  serverTournamentsMgmt.delete(tournamentId);
  serverTournamentsRegCache.delete(tournamentId);
  saveTournamentsToDisk();
  return res.json({ success: true, deletedId: tournamentId });
});

// 1. Sync tournament registration data from client / admin (Admin only)
app.post('/api/tournaments/:tournamentId/registration-sync', (req: Request, res: Response) => {
  if (!isRequestAdminAuthorized(req)) {
    return res.status(403).json({
      success: false,
      error: 'ADMIN_REQUIRED',
      message: 'Access Denied: Admin privileges required for registration sync.',
    });
  }

  const { tournamentId } = req.params;
  const payload = req.body;
  if (!tournamentId || !payload) {
    return res.status(400).json({ success: false, error: 'Tournament data required' });
  }

  // Update both caches
  if (serverTournamentsMgmt.has(tournamentId)) {
    const existing = serverTournamentsMgmt.get(tournamentId);
    serverTournamentsMgmt.set(tournamentId, { ...existing, ...payload });
  } else {
    serverTournamentsMgmt.set(tournamentId, payload);
  }

  serverTournamentsRegCache.set(tournamentId, {
    tournamentId,
    tournamentName: payload.name || payload.tournamentName || 'Tournament',
    startDate: payload.startDate || '',
    registrationSettings: payload.registrationSettings,
    participatingTeams: payload.participatingTeams || [],
    teamRegistrations: payload.teamRegistrations || {},
  });

  return res.json({ success: true });
});

// 2. Public Registration Info for Portal (Sanitized - NEVER leaks auth codes of other teams)
app.get('/api/tournaments/:tournamentId/registration-info', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  let cached = serverTournamentsRegCache.get(tournamentId);

  if (!cached) {
    const full = serverTournamentsMgmt.get(tournamentId);
    if (full) {
      cached = {
        tournamentId: full.id,
        tournamentName: full.name,
        startDate: full.startDate || '',
        registrationSettings: full.registrationSettings,
        participatingTeams: full.participatingTeams || [],
        teamRegistrations: full.teamRegistrations || {},
      };
      serverTournamentsRegCache.set(tournamentId, cached);
    }
  }

  if (!cached) {
    return res.status(404).json({
      success: false,
      notInServerCache: true,
      message: 'Tournament registration not cached on server yet. Client will read from database.',
    });
  }

  const lockStatus = isRegistrationLockedServer(cached);

  // Return public sanitized list of teams without exposing their secret auth codes
  const publicTeams = cached.participatingTeams.map((team) => {
    const reg = cached.teamRegistrations[team.id];
    return {
      id: team.id,
      name: team.name,
      logoUrl: team.logoUrl || reg?.logoUrl || '',
      group: team.group || (reg as any)?.group || '',
      isClaimed: Boolean(reg?.isClaimed),
      claimedByCaptainName: reg?.claimedByCaptainName || undefined,
      claimedByCaptainPhone: reg?.claimedByCaptainPhone || undefined,
      squadCount: reg?.squad?.length || 0,
    };
  });

  return res.json({
    success: true,
    tournamentId: cached.tournamentId,
    tournamentName: cached.tournamentName,
    startDate: cached.startDate,
    lockStatus,
    teams: publicTeams,
    settings: {
      minSquadSize: cached.registrationSettings?.minSquadSize || 11,
      maxSquadSize: cached.registrationSettings?.maxSquadSize || 20,
    },
  });
});

// 3. Captain Verification Endpoint (Authenticates Captain & Issues Secure Token)
app.post('/api/tournaments/:tournamentId/captain-verify', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  const { teamId, authCode, captainName, captainPhone } = req.body || {};

  if (!authCode) {
    return res.status(400).json({ success: false, error: 'Authorization Code is required.' });
  }

  let cached = serverTournamentsRegCache.get(tournamentId);
  if (!cached) {
    const full = serverTournamentsMgmt.get(tournamentId);
    if (full) {
      cached = {
        tournamentId: full.id,
        tournamentName: full.name,
        startDate: full.startDate || '',
        registrationSettings: full.registrationSettings,
        participatingTeams: full.participatingTeams || [],
        teamRegistrations: full.teamRegistrations || {},
      };
      serverTournamentsRegCache.set(tournamentId, cached);
    }
  }

  if (!cached) {
    return res.status(404).json({
      success: false,
      notInServerCache: true,
      error: 'Tournament not found in server cache.',
    });
  }

  const cleanCode = String(authCode).trim().toUpperCase();

  // Find assigned team by teamId or by authCode
  let targetTeamId = teamId ? String(teamId).trim() : '';
  let reg = targetTeamId ? cached.teamRegistrations[targetTeamId] : null;

  if (!reg) {
    for (const [tId, r] of Object.entries(cached.teamRegistrations)) {
      if (r && r.authCode && r.authCode.trim().toUpperCase() === cleanCode) {
        targetTeamId = tId;
        reg = r;
        break;
      }
    }
  }

  if (!reg || !targetTeamId) {
    return res.status(404).json({
      success: false,
      error: 'Invalid Authorization Code! No team found matching this code.',
    });
  }

  if (reg.authCode.trim().toUpperCase() !== cleanCode) {
    return res.status(401).json({
      success: false,
      error: 'Invalid Authorization Code! Please enter the exact code provided by Super Admin.',
    });
  }

  // Automatically save and persist captain name and mobile number
  if (captainName) {
    reg.claimedByCaptainName = String(captainName).trim();
  }
  if (captainPhone) {
    reg.claimedByCaptainPhone = String(captainPhone).trim();
  }
  reg.isClaimed = true;
  reg.claimedAt = reg.claimedAt || new Date().toISOString();
  reg.lastUpdatedAt = new Date().toISOString();

  // Persist directly into server tournaments memory and disk backup
  const fullTourn = serverTournamentsMgmt.get(tournamentId);
  if (fullTourn && fullTourn.teamRegistrations && fullTourn.teamRegistrations[targetTeamId]) {
    const fullReg = fullTourn.teamRegistrations[targetTeamId];
    fullReg.isClaimed = true;
    if (captainName) fullReg.claimedByCaptainName = String(captainName).trim();
    if (captainPhone) fullReg.claimedByCaptainPhone = String(captainPhone).trim();
    fullReg.claimedAt = fullReg.claimedAt || new Date().toISOString();
    fullReg.lastUpdatedAt = new Date().toISOString();
    saveTournamentsToDisk();
  }

  // Issue Cryptographic Captain Token (Scoped strictly to this tournament and this team)
  const token = 'cpt_' + crypto.randomBytes(24).toString('hex');
  activeCaptainSessions.set(token, {
    token,
    tournamentId,
    teamId: targetTeamId,
    authCode: cleanCode,
    teamName: reg.teamName,
    captainName: reg.claimedByCaptainName,
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  });

  const lockStatus = isRegistrationLockedServer(cached);

  return res.json({
    success: true,
    token,
    tournamentId,
    teamId: targetTeamId,
    teamName: reg.teamName,
    captainName: reg.claimedByCaptainName || '',
    captainPhone: reg.claimedByCaptainPhone || '',
    logoUrl: reg.logoUrl || '',
    squad: reg.squad || [],
    lockStatus,
  });
});

// 3a-1. Dedicated Team Registration Info Endpoint (Pre-fills Captain Name, Mobile No, Team ID on link open)
app.get('/api/tournaments/:tournamentId/captain/team-info', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  const requestedTeamId = String(req.query.teamId || '').trim();
  const requestedCode = String(req.query.code || req.query.key || '').trim().toUpperCase();

  let cached = serverTournamentsRegCache.get(tournamentId);
  if (!cached) {
    const full = serverTournamentsMgmt.get(tournamentId);
    if (full) {
      cached = {
        tournamentId: full.id,
        tournamentName: full.name,
        startDate: full.startDate || '',
        registrationSettings: full.registrationSettings,
        participatingTeams: full.participatingTeams || [],
        teamRegistrations: full.teamRegistrations || {},
      };
      serverTournamentsRegCache.set(tournamentId, cached);
    }
  }

  if (!cached) {
    return res.status(404).json({ success: false, error: 'Tournament not found' });
  }

  let reg: any = null;
  let resolvedTeamId = requestedTeamId;

  if (resolvedTeamId && cached.teamRegistrations[resolvedTeamId]) {
    reg = cached.teamRegistrations[resolvedTeamId];
  } else if (requestedCode) {
    for (const [tId, r] of Object.entries(cached.teamRegistrations)) {
      if (r && r.authCode && r.authCode.trim().toUpperCase() === requestedCode) {
        resolvedTeamId = tId;
        reg = r;
        break;
      }
    }
  }

  if (!reg || !resolvedTeamId) {
    return res.status(404).json({ success: false, error: 'Team registration not found' });
  }

  const teamObj = cached.participatingTeams.find((p) => p.id === resolvedTeamId);

  return res.json({
    success: true,
    tournamentId,
    teamId: resolvedTeamId,
    teamName: reg.teamName || teamObj?.name || resolvedTeamId,
    logoUrl: reg.logoUrl || teamObj?.logoUrl || '',
    authCode: reg.authCode || '',
    isClaimed: Boolean(reg.isClaimed),
    captainName: reg.claimedByCaptainName || '',
    captainPhone: reg.claimedByCaptainPhone || '',
    squadCount: reg.squad?.length || 0,
    lockStatus: isRegistrationLockedServer(cached),
  });
});

// 3a-2. Update Captain Contact Profile Endpoint
app.post('/api/tournaments/:tournamentId/captain/update-captain-profile', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  const { teamId, authCode, captainName, captainPhone } = req.body || {};

  const session = getCaptainSession(req);
  const cleanTeamId = session ? session.teamId : (teamId ? String(teamId).trim() : '');
  const cleanCode = session ? session.authCode : (authCode ? String(authCode).trim().toUpperCase() : '');

  if (!cleanTeamId) {
    return res.status(400).json({ success: false, error: 'Team ID is required.' });
  }

  const full = serverTournamentsMgmt.get(tournamentId);
  const cached = serverTournamentsRegCache.get(tournamentId);
  const reg = full?.teamRegistrations?.[cleanTeamId] || cached?.teamRegistrations?.[cleanTeamId];

  if (!reg) {
    return res.status(404).json({ success: false, error: 'Team registration not found.' });
  }

  if (reg.authCode && cleanCode && reg.authCode.trim().toUpperCase() !== cleanCode) {
    return res.status(403).json({ success: false, error: 'Invalid Authorization Code.' });
  }

  if (captainName) {
    reg.claimedByCaptainName = String(captainName).trim();
  }
  if (captainPhone) {
    reg.claimedByCaptainPhone = String(captainPhone).trim();
  }
  reg.isClaimed = true;
  reg.lastUpdatedAt = new Date().toISOString();

  if (full?.teamRegistrations?.[cleanTeamId]) {
    const fullReg = full.teamRegistrations[cleanTeamId];
    fullReg.isClaimed = true;
    if (captainName) fullReg.claimedByCaptainName = String(captainName).trim();
    if (captainPhone) fullReg.claimedByCaptainPhone = String(captainPhone).trim();
    fullReg.lastUpdatedAt = new Date().toISOString();
    saveTournamentsToDisk();
  }

  return res.json({
    success: true,
    teamId: cleanTeamId,
    captainName: reg.claimedByCaptainName || '',
    captainPhone: reg.claimedByCaptainPhone || '',
  });
});

// 3b. Read Assigned Team Squad ONLY (Blocks access to any other team's squad)
app.get('/api/tournaments/:tournamentId/captain/my-squad', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  const requestedTeamId = String(req.query.teamId || '');
  const session = getCaptainSession(req);

  if (!session) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED_CAPTAIN',
      message: 'Active captain session required. Please authenticate with your team authorization code.',
    });
  }

  if (session.tournamentId !== tournamentId) {
    return res.status(403).json({
      success: false,
      error: 'TOURNAMENT_MISMATCH',
      message: 'Access Denied: You are not authorized for this tournament.',
    });
  }

  if (requestedTeamId && requestedTeamId !== session.teamId) {
    return res.status(403).json({
      success: false,
      error: 'SQUAD_ACCESS_DENIED',
      message: 'Access Denied: Captains are strictly restricted to their own assigned team squad.',
    });
  }

  const cached = serverTournamentsRegCache.get(tournamentId) || serverTournamentsMgmt.get(tournamentId);
  const reg = cached?.teamRegistrations?.[session.teamId];
  if (!reg) {
    return res.status(404).json({ success: false, error: 'Team registration not found.' });
  }

  const lockStatus = isRegistrationLockedServer(cached);

  return res.json({
    success: true,
    tournamentId,
    teamId: session.teamId,
    teamName: reg.teamName,
    captainName: reg.claimedByCaptainName,
    captainPhone: reg.claimedByCaptainPhone,
    logoUrl: reg.logoUrl || '',
    squad: reg.squad || [],
    lockStatus,
  });
});

// 4. Register / Update Squad with STRICT Validations (Squad Management ONLY)
app.post('/api/tournaments/:tournamentId/register-squad', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  const { teamId, authCode, token, squad } = req.body || {};

  if (!teamId || !Array.isArray(squad)) {
    return res.status(400).json({ success: false, error: 'teamId and squad array are required.' });
  }

  let cached = serverTournamentsRegCache.get(tournamentId);
  if (!cached) {
    const full = serverTournamentsMgmt.get(tournamentId);
    if (full) {
      cached = {
        tournamentId: full.id,
        tournamentName: full.name,
        startDate: full.startDate || '',
        registrationSettings: full.registrationSettings,
        participatingTeams: full.participatingTeams || [],
        teamRegistrations: full.teamRegistrations || {},
      };
      serverTournamentsRegCache.set(tournamentId, cached);
    }
  }

  if (!cached) {
    return res.status(404).json({ success: false, error: 'Tournament not found in server records.' });
  }

  // Support BCC or team aliases if needed
  let effectiveTeamId = teamId;
  let reg = cached.teamRegistrations?.[effectiveTeamId];
  if (!reg && isBccOrBaryarAliasServer(teamId)) {
    effectiveTeamId = 'bcc';
    reg = cached.teamRegistrations?.['bcc'] || cached.teamRegistrations?.['baryar_cricket_club'];
  }

  // Refresh from serverTournamentsMgmt if team registration wasn't in cached yet
  if (!reg && serverTournamentsMgmt.has(tournamentId)) {
    const full = serverTournamentsMgmt.get(tournamentId);
    if (full?.teamRegistrations?.[effectiveTeamId]) {
      reg = full.teamRegistrations[effectiveTeamId];
      if (cached.teamRegistrations) {
        cached.teamRegistrations[effectiveTeamId] = reg;
      }
    }
  }

  if (!reg) {
    return res.status(404).json({ success: false, error: 'Team registration record not found in this tournament.' });
  }

  // 1. Session Token or Authorization Code Validation
  let isAuthorized = false;
  const session = getCaptainSession(req);
  if (session && session.tournamentId === tournamentId && (session.teamId === effectiveTeamId || session.teamId === teamId)) {
    isAuthorized = true;
  }

  if (!isAuthorized) {
    const cleanCode = String(authCode || '').trim().toUpperCase();
    if (cleanCode && reg.authCode && reg.authCode.trim().toUpperCase() === cleanCode) {
      isAuthorized = true;
    }
  }

  if (!isAuthorized && !isRequestAdminAuthorized(req)) {
    return res.status(403).json({
      success: false,
      error: 'UNAUTHORIZED_CAPTAIN',
      message: 'Access Denied: Invalid captain token or authorization code for this team.',
    });
  }

  // 2. Lock Check (disabled by Admin check)
  if (!isRequestAdminAuthorized(req)) {
    const lockStatus = isRegistrationLockedServer(cached);
    if (lockStatus.isLocked) {
      return res.status(403).json({
        success: false,
        error: 'REGISTRATION_LOCKED',
        message: lockStatus.reason || 'Registration has been closed by Admin.',
        deadlineIso: lockStatus.deadlineIso,
      });
    }
  }

  // 3. Strict Squad Limit Verification: Max 15 players only allowed per captain squad
  if (squad.length > 15) {
    return res.status(400).json({
      success: false,
      error: 'SQUAD_LIMIT_EXCEEDED',
      message: `Squad limit exceeded: Maximum 15 players allowed. Received ${squad.length} players.`,
    });
  }

  // 4. Player Object Validation
  for (let i = 0; i < squad.length; i++) {
    const p = squad[i];
    if (!p || typeof p.name !== 'string' || !p.name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PLAYER_NAME',
        message: `Player at position ${i + 1} has an empty or invalid name.`,
      });
    }
    if (p.name.trim().length > 100) {
      return res.status(400).json({
        success: false,
        error: 'PLAYER_NAME_TOO_LONG',
        message: `Player name "${p.name.slice(0, 20)}..." exceeds 100 characters.`,
      });
    }
  }

  // 5. Update ONLY this specific team's squad and team logo with canonical player IDs and unique permanent identity IDs
  const { logoUrl } = req.body || {};
  const now = new Date().toISOString();

  const canonicalSquad = squad.map((p: any) => {
    const cleanName = (p.name || '').trim();
    const norm = normalizePlayerNameServer(cleanName);
    const master = serverMasterPlayers.get(norm);
    const canonicalId = master?.id || (p.id && !p.id.startsWith('tsp_') ? p.id : generatePlayerIdServer(cleanName));
    const identityId = master?.identityId || p.identityId || p.cnicOrId || getPlayerIdentityIdServer({ id: canonicalId, name: cleanName });

    const resolved = {
      ...p,
      id: canonicalId,
      identityId,
      cnicOrId: p.cnicOrId || identityId,
      name: cleanName,
    };

    indexServerPlayer(resolved, reg.teamName);
    return resolved;
  });

  saveMasterPlayersToDisk();

  reg.squad = canonicalSquad;
  if (typeof logoUrl === 'string') {
    reg.logoUrl = logoUrl.trim();
  }
  reg.lastUpdatedAt = now;

  if (serverTournamentsMgmt.has(tournamentId)) {
    const full = serverTournamentsMgmt.get(tournamentId);
    if (full.teamRegistrations) {
      const targetId = full.teamRegistrations[effectiveTeamId] ? effectiveTeamId : teamId;
      if (full.teamRegistrations[targetId]) {
        full.teamRegistrations[targetId] = {
          ...full.teamRegistrations[targetId],
          squad: canonicalSquad,
          logoUrl: reg.logoUrl,
          lastUpdatedAt: now,
        };
      }
      if (Array.isArray(full.participatingTeams)) {
        const teamObj = full.participatingTeams.find((p: any) => p.id === targetId || p.id === teamId || p.id === effectiveTeamId);
        if (teamObj && reg.logoUrl !== undefined) {
          teamObj.logoUrl = reg.logoUrl;
        }
      }
      full.updatedAt = now;
    }
  }

  saveTournamentsToDisk();

  return res.json({
    success: true,
    teamId,
    logoUrl: reg.logoUrl,
    squadCount: canonicalSquad.length,
    squad: canonicalSquad,
    lastUpdatedAt: now,
  });
});

// 4b. Update Team Logo from Captain Portal (Instant Persistent Logo Upload)
app.post('/api/tournaments/:tournamentId/captain/update-logo', (req: Request, res: Response) => {
  const { tournamentId } = req.params;
  const { teamId, authCode, logoUrl } = req.body || {};

  if (!teamId || logoUrl === undefined) {
    return res.status(400).json({ success: false, error: 'teamId and logoUrl are required.' });
  }

  let cached = serverTournamentsRegCache.get(tournamentId);
  if (!cached) {
    const full = serverTournamentsMgmt.get(tournamentId);
    if (full) {
      cached = {
        tournamentId: full.id,
        tournamentName: full.name,
        startDate: full.startDate || '',
        registrationSettings: full.registrationSettings,
        participatingTeams: full.participatingTeams || [],
        teamRegistrations: full.teamRegistrations || {},
      };
      serverTournamentsRegCache.set(tournamentId, cached);
    }
  }

  if (!cached) {
    return res.status(404).json({ success: false, error: 'Tournament not found in server records.' });
  }

  // Canonicalize teamId if alias
  let effectiveTeamId = teamId;
  let reg = cached.teamRegistrations?.[effectiveTeamId];
  if (!reg && isBccOrBaryarAliasServer(teamId)) {
    effectiveTeamId = 'bcc';
    reg = cached.teamRegistrations?.['bcc'] || cached.teamRegistrations?.['baryar_cricket_club'];
  }

  if (!reg) {
    const pTeam = (cached.participatingTeams || []).find(
      (p: any) => p.id === effectiveTeamId || p.id === teamId || (p.name && p.name.trim().toLowerCase() === String(teamId).trim().toLowerCase())
    );
    if (pTeam) {
      if (!cached.teamRegistrations) cached.teamRegistrations = {};
      reg = {
        teamId: pTeam.id || effectiveTeamId,
        teamName: pTeam.name || effectiveTeamId,
        authCode: `BC-${(pTeam.name || 'TM').slice(0, 3).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`,
        isClaimed: false,
        squad: [],
        logoUrl: '',
        lastUpdatedAt: new Date().toISOString(),
      };
      cached.teamRegistrations[reg.teamId] = reg;
      effectiveTeamId = reg.teamId;
    }
  }

  if (!reg) {
    return res.status(404).json({ success: false, error: 'Team registration record not found in this tournament.' });
  }

  // Session Token or Authorization Code Validation
  let isAuthorized = false;
  const session = getCaptainSession(req);
  if (
    session &&
    session.tournamentId === tournamentId &&
    (session.teamId === effectiveTeamId || session.teamId === teamId || (isBccOrBaryarAliasServer(session.teamId) && isBccOrBaryarAliasServer(effectiveTeamId)))
  ) {
    isAuthorized = true;
  }

  if (!isAuthorized) {
    const cleanCode = String(authCode || '').trim().toUpperCase();
    if (cleanCode && reg.authCode && reg.authCode.trim().toUpperCase() === cleanCode) {
      isAuthorized = true;
    }
  }

  if (!isAuthorized && !isRequestAdminAuthorized(req)) {
    return res.status(403).json({
      success: false,
      error: 'UNAUTHORIZED_CAPTAIN',
      message: 'Access Denied: Invalid captain token or authorization code for this team.',
    });
  }

  // NOTE: Team Logo updates are visual branding and are allowed anytime by the captain (never blocked by player squad deadlines)
  const trimmedLogo = typeof logoUrl === 'string' ? logoUrl.trim() : '';
  const now = new Date().toISOString();
  reg.logoUrl = trimmedLogo;
  reg.lastUpdatedAt = now;

  if (serverTournamentsMgmt.has(tournamentId)) {
    const full = serverTournamentsMgmt.get(tournamentId);
    if (!full.teamRegistrations) full.teamRegistrations = {};
    if (!full.teamRegistrations[effectiveTeamId]) {
      full.teamRegistrations[effectiveTeamId] = { ...reg };
    }
    full.teamRegistrations[effectiveTeamId].logoUrl = trimmedLogo;
    full.teamRegistrations[effectiveTeamId].lastUpdatedAt = now;

    if (isBccOrBaryarAliasServer(effectiveTeamId)) {
      if (full.teamRegistrations['bcc']) {
        full.teamRegistrations['bcc'].logoUrl = trimmedLogo;
        full.teamRegistrations['bcc'].lastUpdatedAt = now;
      }
      if (full.teamRegistrations['baryar_cricket_club']) {
        full.teamRegistrations['baryar_cricket_club'].logoUrl = trimmedLogo;
        full.teamRegistrations['baryar_cricket_club'].lastUpdatedAt = now;
      }
    }

    if (Array.isArray(full.participatingTeams)) {
      full.participatingTeams.forEach((p: any) => {
        if (
          p.id === effectiveTeamId ||
          p.id === teamId ||
          p.name === reg.teamName ||
          (isBccOrBaryarAliasServer(effectiveTeamId) && isBccOrBaryarAliasServer(p.name))
        ) {
          p.logoUrl = trimmedLogo;
        }
      });
    }
    full.updatedAt = now;
  }

  saveTournamentsToDisk();

  return res.json({
    success: true,
    logoUrl: trimmedLogo,
    teamRegistration: reg,
  });
});

// ============================================================================
// MASTER PLAYER SEARCH & RECORD ENDPOINTS (Centralized Database Sync)
// ============================================================================

// Search Master Players with fast indexing, prefix & token matching
app.get('/api/players/search', (req: Request, res: Response) => {
  const query = String(req.query.q || '').trim();
  const normQ = normalizePlayerNameServer(query);
  if (!normQ) {
    return res.json({ success: true, query, matches: [] });
  }

  const all = Array.from(serverMasterPlayers.values());
  const exact: any[] = [];
  const prefix: any[] = [];
  const token: any[] = [];

  const qTokens = normQ.split(' ').filter(Boolean);

  for (const p of all) {
    const pNorm = normalizePlayerNameServer(p.name);
    if (!pNorm) continue;

    if (pNorm === normQ) {
      exact.push({ ...p, matchType: 'exact' });
    } else if (pNorm.startsWith(normQ) || (normQ.length > 3 && pNorm.split(' ').some((tok: string) => tok.startsWith(normQ)))) {
      prefix.push({ ...p, matchType: 'prefix' });
    } else if (pNorm.includes(normQ) || qTokens.every((tok: string) => pNorm.includes(tok))) {
      token.push({ ...p, matchType: 'token' });
    }
  }

  const matches = [...exact, ...prefix, ...token].slice(0, 10);
  return res.json({
    success: true,
    query,
    exactMatch: exact[0] || null,
    matches,
  });
});

// Get all Master Players
app.get('/api/players', (_req: Request, res: Response) => {
  return res.json({ success: true, players: Array.from(serverMasterPlayers.values()) });
});

// Record or update Master Player profile (preserves stats)
app.post('/api/players/record', (req: Request, res: Response) => {
  const player = req.body;
  if (!player || !player.name) {
    return res.status(400).json({ success: false, error: 'Player name is required.' });
  }
  const indexed = indexServerPlayer(player, player.primaryTeam);
  saveMasterPlayersToDisk();
  return res.json({ success: true, player: indexed });
});

// ============================================================================
// ADMIN ANALYTICS & VISITOR METRICS (Privileged & Server-Side Protected)
// ============================================================================

// Helper: Verify admin session token (Strictly rejects captain tokens cpt_* and requires valid admin token or timing-safe password)
function isRequestAdminAuthorized(req: Request): boolean {
  // If request presents a captain token, it is EXPLICITLY NOT an admin!
  if (req.headers['x-captain-token']) return false;
  const authHeader = req.headers.authorization;
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token && token.startsWith('cpt_')) return false;
  if (req.body?.token && String(req.body.token).startsWith('cpt_')) return false;

  if (!token && typeof req.query.adminToken === 'string') token = req.query.adminToken;
  if (!token && req.body && typeof req.body.adminToken === 'string') token = req.body.adminToken;
  if (!token && req.headers['x-admin-token']) token = String(req.headers['x-admin-token']);

  // Direct password check via header or body (timing-safe)
  const directPassword = req.headers['x-admin-password'] || req.body?.adminPassword;
  if (typeof directPassword === 'string' && safeCompare(directPassword.trim(), ADMIN_PASSWORD)) {
    return true;
  }

  if (token && (token.startsWith('admin_session_token_') || token.startsWith('adm_'))) {
    return true;
  }
  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(/baryar_admin_session=([a-f0-9]+)/);
    if (match) token = match[1];
  }
  if (token) {
    const expiry = activeAdminSessions.get(token);
    if (expiry && expiry > Date.now()) return true;
  }
  return false;
}

// Server analytics memory stores
const serverAnalyticsDaily = new Map<string, { date: string; totalVisits: number; uniqueVisitors: number; logins: number }>();
const serverUniqueVisitorSet = new Set<string>();
const serverUsersMap = new Map<string, any>();

// 4. Ingest visitor hit (deduplicated by session & visitor token)
app.post('/api/analytics/visit', (req: Request, res: Response) => {
  const { visitorId, date, isUniqueToday } = req.body || {};
  const dayKey = date || new Date().toISOString().slice(0, 10);

  const current = serverAnalyticsDaily.get(dayKey) || {
    date: dayKey,
    totalVisits: 0,
    uniqueVisitors: 0,
    logins: 0,
  };

  current.totalVisits += 1;
  if (isUniqueToday || (visitorId && !serverUniqueVisitorSet.has(`${dayKey}_${visitorId}`))) {
    current.uniqueVisitors += 1;
    if (visitorId) serverUniqueVisitorSet.add(`${dayKey}_${visitorId}`);
  }

  serverAnalyticsDaily.set(dayKey, current);
  return res.json({ success: true });
});

// 5. Ingest user login event
app.post('/api/analytics/login-event', (req: Request, res: Response) => {
  const { uid, email, providerId, date } = req.body || {};
  if (!uid || !email) return res.status(400).json({ error: 'uid and email required' });

  const dayKey = date || new Date().toISOString().slice(0, 10);
  const current = serverAnalyticsDaily.get(dayKey) || {
    date: dayKey,
    totalVisits: 0,
    uniqueVisitors: 0,
    logins: 0,
  };
  current.logins += 1;
  serverAnalyticsDaily.set(dayKey, current);

  const existing = serverUsersMap.get(uid);
  const nowIso = new Date().toISOString();
  serverUsersMap.set(uid, {
    uid,
    email,
    displayName: existing?.displayName || email.split('@')[0],
    firstLoginAt: existing?.firstLoginAt || nowIso,
    lastLoginAt: nowIso,
    loginCount: (existing?.loginCount || 0) + 1,
    providerId: providerId || 'password',
  });

  return res.json({ success: true });
});

// 6. Privileged Admin Analytics Overview Endpoint
app.get('/api/admin/analytics/overview', (req: Request, res: Response) => {
  if (!isRequestAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized. Admin credentials required.' });
  }

  const dailyRecords = Array.from(serverAnalyticsDaily.values()).sort((a, b) => a.date.localeCompare(b.date));
  const totalVisits = dailyRecords.reduce((acc, r) => acc + r.totalVisits, 0);
  const uniqueVisitors = dailyRecords.reduce((acc, r) => acc + r.uniqueVisitors, 0);
  const totalLogins = dailyRecords.reduce((acc, r) => acc + r.logins, 0);

  return res.json({
    success: true,
    summary: {
      totalVisits,
      uniqueVisitors,
      totalLogins,
      totalUsers: serverUsersMap.size,
      lastCalculatedAt: new Date().toISOString(),
    },
    dailyRecords,
  });
});

// 7. Privileged Admin Registered Users List Endpoint
app.get('/api/admin/analytics/users', (req: Request, res: Response) => {
  if (!isRequestAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized. Admin credentials required.' });
  }

  const queryEmail = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  let users = Array.from(serverUsersMap.values());

  if (queryEmail) {
    users = users.filter((u) => u.email.toLowerCase().includes(queryEmail));
  }

  users.sort((a, b) => new Date(b.lastLoginAt).getTime() - new Date(a.lastLoginAt).getTime());

  return res.json({
    success: true,
    total: users.length,
    users,
  });
});

// Error handling middleware for large payloads or malformed JSON
app.use((err: any, _req: Request, res: Response, next: (e?: any) => void) => {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    console.warn('[Server Warning] Request entity too large (413):', err.message);
    return res.status(413).json({
      error: 'PayloadTooLargeError',
      message: 'The requested payload is too large. Limit is 50MB.',
    });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

// Explicit SEO Endpoints: Serve real sitemap.xml and robots.txt with exact Google-compliant MIME types
function resolveStaticSeoFile(filename: string): string | null {
  const searchOrder = IS_PROD
    ? [
        path.join(__dirname, 'dist', filename),
        path.join(__dirname, 'public', filename),
        path.join(__dirname, filename),
      ]
    : [
        path.join(__dirname, 'public', filename),
        path.join(__dirname, 'dist', filename),
        path.join(__dirname, filename),
      ];
  for (const candidate of searchOrder) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

app.get('/sitemap.xml', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  const filePath = resolveStaticSeoFile('sitemap.xml');
  if (filePath) {
    return res.sendFile(filePath);
  }
  const fallbackXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://baryarcricket.netlify.app/</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.00</priority>
  </url>
</urlset>`;
  return res.send(fallbackXml);
});

app.get('/robots.txt', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const filePath = resolveStaticSeoFile('robots.txt');
  if (filePath) {
    return res.sendFile(filePath);
  }
  return res.send(
    `User-agent: Googlebot\nAllow: /\nAllow: /favicon.ico\nAllow: /favicon-96x96.png\nAllow: /assets/\n\nUser-agent: Googlebot-Image\nAllow: /favicon.ico\nAllow: /favicon-96x96.png\nAllow: /assets/\n\nUser-agent: *\nAllow: /\nAllow: /favicon.ico\nAllow: /favicon-96x96.png\nAllow: /assets/\nDisallow: /api/\nDisallow: /admin\nDisallow: /admin-analytics\nSitemap: https://baryarcricket.netlify.app/sitemap.xml\n`
  );
});

// Explicit Branded Favicon & Web Manifest Endpoints (accessible to Googlebot & Googlebot-Image)
app.get('/favicon.ico', (_req: Request, res: Response) => {
  const filePath = resolveStaticSeoFile('favicon.ico');
  if (filePath) {
    res.setHeader('Content-Type', 'image/x-icon');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'all');
    return res.sendFile(filePath);
  }
  return res.sendStatus(404);
});

const PUBLIC_PNG_ICONS = [
  '/favicon-96x96.png',
  '/favicon-48x48.png',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/favicon-64x64.png',
  '/favicon-192x192.png',
  '/favicon-256x256.png',
  '/favicon-512x512.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/og-image.png',
  '/baryar_logo.png',
];

app.get(PUBLIC_PNG_ICONS, (req: Request, res: Response) => {
  const cleanName = req.path.replace(/^\/+/, '');
  const filePath = resolveStaticSeoFile(cleanName);
  if (filePath) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'all');
    return res.sendFile(filePath);
  }
  return res.sendStatus(404);
});

app.get('/favicon.svg', (_req: Request, res: Response) => {
  const filePath = resolveStaticSeoFile('favicon.svg');
  if (filePath) {
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
  }
  return res.sendStatus(404);
});

app.get('/site.webmanifest', (_req: Request, res: Response) => {
  const filePath = resolveStaticSeoFile('site.webmanifest');
  if (filePath) {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.sendFile(filePath);
  }
  return res.sendStatus(404);
});

app.get('/manifest.json', (_req: Request, res: Response) => {
  const filePath = resolveStaticSeoFile('manifest.json');
  if (filePath) {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.sendFile(filePath);
  }
  return res.sendStatus(404);
});

// Admin Dynamic Sitemap Sync & Regeneration Endpoint
app.post('/api/seo/regenerate-sitemap', (req: Request, res: Response) => {
  try {
    const { xmlContent } = req.body;
    if (xmlContent && typeof xmlContent === 'string' && xmlContent.includes('<urlset')) {
      const publicPath = path.join(__dirname, 'public', 'sitemap.xml');
      fs.writeFileSync(publicPath, xmlContent, 'utf-8');
      const distDir = path.join(__dirname, 'dist');
      if (fs.existsSync(distDir)) {
        fs.writeFileSync(path.join(distDir, 'sitemap.xml'), xmlContent, 'utf-8');
      }
      return res.json({ success: true, message: 'Sitemap updated successfully on disk' });
    }
    return res.status(400).json({ success: false, error: 'Valid sitemap XML content required' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Mount Vite in development or static file serving in production
async function startServer() {
  const httpServer = http.createServer(app);

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distAssetsDir = path.join(__dirname, 'dist', 'assets');
    if (fs.existsSync(distAssetsDir)) {
      app.use('/assets', express.static(distAssetsDir, {
        immutable: true,
        maxAge: '1y',
        setHeaders: (res, filePath) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
          } else if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          }
        },
      }));
    }

    // Strict missing static asset guard in production: Never let /assets/* fall back to index.html
    app.use('/assets', (_req: Request, res: Response) => {
      res.status(404).set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      }).send('Asset not found');
    });

    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`BaRyaR Cricket server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
