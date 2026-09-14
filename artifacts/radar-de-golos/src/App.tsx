import { useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  CalendarDays,
  ChevronRight,
  Clock3,
  Goal,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Trophy,
} from 'lucide-react';
import {
  getGetTodayFixturesQueryKey,
  useGetTodayFixtures,
  type Fixture,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

type MarketMode = 'full' | 'firstHalf' | 'live';

type SimulatedAnalysis = {
  line: string;
  odds: number;
  probability: number;
  edge: number;
  goalsAverage: number;
  form: number;
  confidence: 'Alta' | 'Média' | 'Baixa';
  minute?: number;
  homeScore?: number;
  awayScore?: number;
};

const modeConfig: Record<
  MarketMode,
  {
    label: string;
    shortLabel: string;
    description: string;
    icon: typeof Goal;
  }
> = {
  full: {
    label: 'Jogo completo',
    shortLabel: 'Completo',
    description: 'Mercados over/under para os 90 minutos',
    icon: Goal,
  },
  firstHalf: {
    label: '1º tempo',
    shortLabel: '1º tempo',
    description: 'Leitura simulada dos primeiros 45 minutos',
    icon: TimerReset,
  },
  live: {
    label: "Ao vivo 75'+",
    shortLabel: "75'+",
    description: 'Minuto e placar simulados sobre jogos reais de hoje',
    icon: Radio,
  },
};

function seededValue(seed: number, offset: number): number {
  const value = Math.sin(seed * 12.9898 + offset * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function buildSimulation(
  fixtureId: number,
  mode: MarketMode,
): SimulatedAnalysis {
  const modeOffset = mode === 'full' ? 1 : mode === 'firstHalf' ? 7 : 13;
  const probability = 54 + Math.round(seededValue(fixtureId, modeOffset) * 22);
  const odds = 1.58 + seededValue(fixtureId, modeOffset + 1) * 0.74;
  const marketProbability = 100 / odds;
  const edge = Math.max(1.2, probability - marketProbability);
  const confidence =
    edge >= 10 ? 'Alta' : edge >= 6 ? 'Média' : ('Baixa' as const);

  return {
    line:
      mode === 'firstHalf'
        ? seededValue(fixtureId, 19) > 0.5
          ? 'Over 0.5 HT'
          : 'Over 1.5 HT'
        : seededValue(fixtureId, 21) > 0.42
          ? 'Over 2.5'
          : 'Over 3.5',
    odds: Number(odds.toFixed(2)),
    probability,
    edge: Number(edge.toFixed(1)),
    goalsAverage: Number(
      (
        (mode === 'firstHalf' ? 0.8 : 2.15) +
        seededValue(fixtureId, modeOffset + 2) *
          (mode === 'firstHalf' ? 1.1 : 2.0)
      ).toFixed(2),
    ),
    form: 58 + Math.round(seededValue(fixtureId, modeOffset + 3) * 34),
    confidence,
    ...(mode === 'live'
      ? {
          minute: 75 + Math.floor(seededValue(fixtureId, 31) * 14),
          homeScore: Math.floor(seededValue(fixtureId, 33) * 4),
          awayScore: Math.floor(seededValue(fixtureId, 35) * 3),
        }
      : {}),
  };
}

function formatKickoff(value: string): string {
  return new Intl.DateTimeFormat('pt-PT', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDate(value?: string): string {
  if (!value) return 'Hoje';
  return new Intl.DateTimeFormat('pt-PT', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

function formatUpdatedAt(value?: string): string {
  if (!value) return 'a carregar';
  return new Intl.DateTimeFormat('pt-PT', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function confidenceClass(confidence: SimulatedAnalysis['confidence']): string {
  if (confidence === 'Alta') return 'confidence-high';
  if (confidence === 'Média') return 'confidence-medium';
  return 'confidence-low';
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={accent ? 'metric-accent' : undefined}>{value}</strong>
    </div>
  );
}

function MatchCard({
  fixture,
  mode,
  index,
}: {
  fixture: Fixture;
  mode: MarketMode;
  index: number;
}) {
  const analysis = useMemo(
    () => buildSimulation(fixture.id, mode),
    [fixture.id, mode],
  );

  return (
    <article
      className="match-card"
      style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
    >
      <div className="match-card-top">
        <div className="competition">
          <Trophy aria-hidden="true" />
          <span>{fixture.league}</span>
          <small>{fixture.country}</small>
        </div>
        <div className="kickoff">
          {mode === 'live' ? (
            <>
              <span className="live-dot" aria-hidden="true" />
              <strong>{analysis.minute}'</strong>
            </>
          ) : (
            <>
              <Clock3 aria-hidden="true" />
              <strong>{formatKickoff(fixture.kickoff)}</strong>
            </>
          )}
        </div>
      </div>

      <div className="fixture-row">
        <div className="teams">
          <div className="team">
            <span className="team-mark">{fixture.homeTeam.charAt(0)}</span>
            <strong>{fixture.homeTeam}</strong>
          </div>
          <div className="team">
            <span className="team-mark away">
              {fixture.awayTeam.charAt(0)}
            </span>
            <strong>{fixture.awayTeam}</strong>
          </div>
        </div>
        {mode === 'live' ? (
          <div className="score" aria-label="Placar simulado">
            <strong>{analysis.homeScore}</strong>
            <span>—</span>
            <strong>{analysis.awayScore}</strong>
          </div>
        ) : (
          <div className="versus">VS</div>
        )}
      </div>

      <div className="market-line">
        <div>
          <span>Melhor sinal simulado</span>
          <strong>{analysis.line}</strong>
        </div>
        <span className={`confidence ${confidenceClass(analysis.confidence)}`}>
          {analysis.confidence}
        </span>
      </div>

      <div className="metrics-grid">
        <Metric label="Odd" value={analysis.odds.toFixed(2)} />
        <Metric
          label="Prob."
          value={`${analysis.probability}%`}
        />
        <Metric label="Edge" value={`+${analysis.edge}%`} accent />
        <Metric label="Média golos" value={analysis.goalsAverage.toFixed(2)} />
        <Metric label="Forma" value={`${analysis.form}%`} />
      </div>

      <button className="analysis-link" type="button">
        Ver análise simulada
        <ChevronRight aria-hidden="true" />
      </button>
    </article>
  );
}

function EmptyState({ isError }: { isError: boolean }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        {isError ? (
          <RefreshCw aria-hidden="true" />
        ) : (
          <CalendarDays aria-hidden="true" />
        )}
      </div>
      <h2>
        {isError
          ? 'Não foi possível carregar os jogos'
          : 'Sem jogos disponíveis para hoje'}
      </h2>
      <p>
        {isError
          ? 'A ligação aos dados reais falhou e ainda não existe uma lista válida em cache.'
          : 'A API-Football não devolveu partidas para a data de hoje.'}
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="cards-grid" aria-label="A carregar jogos">
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="match-card skeleton-card" key={index}>
          <div className="skeleton-line small" />
          <div className="skeleton-line large" />
          <div className="skeleton-line large" />
          <div className="skeleton-box" />
        </div>
      ))}
    </div>
  );
}

function Dashboard() {
  const [mode, setMode] = useState<MarketMode>('full');
  const { data, isLoading, isError, isFetching, refetch } =
    useGetTodayFixtures({
      query: {
        queryKey: getGetTodayFixturesQueryKey(),
        staleTime: FIFTEEN_MINUTES,
        refetchInterval: FIFTEEN_MINUTES,
      },
    });

  const fixtures = data?.fixtures ?? [];
  const ModeIcon = modeConfig[mode].icon;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Radar de Golos">
          <span className="brand-mark">
            <Activity aria-hidden="true" />
          </span>
          <span>
            <strong>Radar</strong>
            <small>de Golos</small>
          </span>
        </a>
        <div className="topbar-status">
          <span className="status-dot" aria-hidden="true" />
          Dados reais ativos
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <CalendarDays aria-hidden="true" />
              {formatDate(data?.date)}
            </div>
            <h1>O radar dos jogos de hoje</h1>
            <p>
              Partidas reais, organizadas para uma leitura rápida de mercados
              de golos em ambiente de teste.
            </p>
          </div>
          <div className="hero-summary">
            <div>
              <span>Jogos encontrados</span>
              <strong>{isLoading ? '—' : fixtures.length}</strong>
            </div>
            <div>
              <span>Última lista</span>
              <strong>{formatUpdatedAt(data?.fetchedAt)}</strong>
            </div>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label="Verificar lista em cache"
            >
              <RefreshCw
                className={isFetching ? 'spinning' : undefined}
                aria-hidden="true"
              />
            </button>
          </div>
        </section>

        <section className="data-notice" aria-label="Informação dos dados">
          <ShieldCheck aria-hidden="true" />
          <p>
            ⚠️ Jogos reais de hoje · Odds e estatísticas ainda simuladas —
            versão de teste
          </p>
        </section>

        {(data?.stale || data?.warning) && (
          <div className="cache-warning" role="status">
            <RefreshCw aria-hidden="true" />
            <span>
              {data.warning ??
                'não foi possível atualizar os jogos — usando última lista válida'}
            </span>
          </div>
        )}

        <nav className="mode-tabs" aria-label="Período de análise">
          {(Object.keys(modeConfig) as MarketMode[]).map((item) => {
            const Icon = modeConfig[item].icon;
            return (
              <button
                type="button"
                key={item}
                className={mode === item ? 'active' : undefined}
                onClick={() => setMode(item)}
                aria-pressed={mode === item}
              >
                <Icon aria-hidden="true" />
                <span>{modeConfig[item].label}</span>
              </button>
            );
          })}
        </nav>

        <section className="section-heading">
          <div className="section-icon">
            <ModeIcon aria-hidden="true" />
          </div>
          <div>
            <span>Análise simulada</span>
            <h2>{modeConfig[mode].label}</h2>
            <p>{modeConfig[mode].description}</p>
          </div>
          <div className="section-pill">
            <Sparkles aria-hidden="true" />
            {fixtures.length} {fixtures.length === 1 ? 'jogo' : 'jogos'}
          </div>
        </section>

        {isLoading ? (
          <LoadingState />
        ) : fixtures.length === 0 ? (
          <EmptyState isError={isError} />
        ) : (
          <div className="cards-grid">
            {fixtures.map((fixture, index) => (
              <MatchCard
                fixture={fixture}
                mode={mode}
                index={index}
                key={`${mode}-${fixture.id}`}
              />
            ))}
          </div>
        )}
      </main>

      <footer>
        <div>
          <BarChart3 aria-hidden="true" />
          <span>
            Identidade dos jogos fornecida pela API-Football. Probabilidades,
            odds, estatísticas, minuto e placar são simulações.
          </span>
        </div>
      </footer>
    </div>
  );
}

function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

function App() {
  return (
    <AppProviders>
      <ErrorBoundary>
        <Dashboard />
      </ErrorBoundary>
      <Toaster />
    </AppProviders>
  );
}

export default App;