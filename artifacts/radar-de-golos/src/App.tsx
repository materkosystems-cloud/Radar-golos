import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  X,
} from 'lucide-react';
import {
  getGetLiveFixturesQueryKey,
  getGetTodayFixturesQueryKey,
  useGetLiveFixtures,
  useGetTodayFixtures,
  type Fixture,
  type LiveFixture,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const TWO_HOURS = 2 * 60 * 60 * 1000;
const TWENTY_MINUTES = 20 * 60 * 1000;
const HIGH_EDGE_THRESHOLD = 25;
const HIGH_PROB_THRESHOLD = 70;

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
  factors: string[];
};

type SelectedMatch = {
  fixture: Fixture | LiveFixture;
  mode: MarketMode;
  markets: SimulatedAnalysis[];
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
    label: 'Ao Vivo',
    shortLabel: 'Ao Vivo',
    description: 'Minuto e placar reais dos jogos atualmente em disputa',
    icon: Radio,
  },
};

function seededValue(seed: number, offset: number): number {
  const value = Math.sin(seed * 12.9898 + offset * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function buildMarketSignals(
  fixtureId: number,
  mode: MarketMode,
): SimulatedAnalysis[] {
  const modeOffset = mode === 'full' ? 1 : mode === 'firstHalf' ? 7 : 13;
  const lines =
    mode === 'firstHalf'
      ? ['Over 0.5 HT', 'Over 1.5 HT', 'Ambas marcam 1T']
      : ['Over 1.5', 'Over 2.5', 'Over 3.5'];

  return lines
    .map((line, index) => {
      const offset = modeOffset + index * 11;
      const probability =
        48 + Math.round(seededValue(fixtureId, offset) * 28);
      const odds = 1.52 + seededValue(fixtureId, offset + 1) * 1.02;
      const marketProbability = 100 / odds;
      const edge = Math.max(1.2, probability - marketProbability);
      const goalsAverage = Number(
        (
          (mode === 'firstHalf' ? 0.8 : 2.15) +
          seededValue(fixtureId, offset + 2) *
            (mode === 'firstHalf' ? 1.1 : 2.0)
        ).toFixed(2),
      );
      const form =
        58 + Math.round(seededValue(fixtureId, offset + 3) * 34);
      const confidence: SimulatedAnalysis['confidence'] =
        edge >= 10 ? 'Alta' : edge >= 6 ? 'Média' : ('Baixa' as const);

      return {
        line,
        odds: Number(odds.toFixed(2)),
        probability,
        edge: Number(edge.toFixed(1)),
        goalsAverage,
        form,
        confidence,
        factors: [
          `Probabilidade simulada de ${probability}% comparada com ${marketProbability.toFixed(1)}% implícitos na odd.`,
          `Média simulada de ${goalsAverage.toFixed(2)} golos para este recorte de mercado.`,
          `Indicador de forma recente estimado em ${form}%.`,
          `Edge robusto calculado em +${edge.toFixed(1)}%, resultando em confiança ${confidence.toLowerCase()}.`,
        ],
      };
    })
    .sort((left, right) => right.edge - left.edge);
}

function isFeaturedSignal(analysis: SimulatedAnalysis): boolean {
  return (
    analysis.edge >= HIGH_EDGE_THRESHOLD &&
    (analysis.confidence === 'Alta' ||
      analysis.probability >= HIGH_PROB_THRESHOLD)
  );
}

function formatKickoff(value: string): string {
  return new Intl.DateTimeFormat('pt-PT', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatFixtureDate(value: string): string {
  const date = new Date(value);
  const monthNames = [
    'Jan',
    'Fev',
    'Mar',
    'Abr',
    'Mai',
    'Jun',
    'Jul',
    'Ago',
    'Set',
    'Out',
    'Nov',
    'Dez',
  ];
  return `${String(date.getDate()).padStart(2, '0')} ${monthNames[date.getMonth()]}`;
}

function isCurrentSystemDate(value: string): boolean {
  const fixtureDate = new Date(value);
  const currentDate = new Date();

  return (
    fixtureDate.getFullYear() === currentDate.getFullYear() &&
    fixtureDate.getMonth() === currentDate.getMonth() &&
    fixtureDate.getDate() === currentDate.getDate()
  );
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
  analysis,
  isFeatured,
  onOpen,
}: {
  fixture: Fixture | LiveFixture;
  mode: MarketMode;
  index: number;
  analysis: SimulatedAnalysis;
  isFeatured: boolean;
  onOpen: () => void;
}) {
  const liveFixture = mode === 'live' ? (fixture as LiveFixture) : null;

  return (
    <article
      className={`match-card${isFeatured ? ' match-card-featured' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      data-testid={`card-match-${fixture.id}`}
    >
      {isFeatured && (
        <div className="featured-signal-badge">
          <Sparkles aria-hidden="true" />
          Sinal em Destaque
        </div>
      )}
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
              <strong>
                {formatFixtureDate(fixture.kickoff)} · {liveFixture?.minute}'
              </strong>
            </>
          ) : (
            <>
              <Clock3 aria-hidden="true" />
              <strong>
                {formatFixtureDate(fixture.kickoff)} ·{' '}
                {formatKickoff(fixture.kickoff)}
              </strong>
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
          <div className="score" aria-label="Placar real">
            <strong>{liveFixture?.homeScore}</strong>
            <span>—</span>
            <strong>{liveFixture?.awayScore}</strong>
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

      <div className="analysis-link">
        Ver análise simulada
        <ChevronRight aria-hidden="true" />
      </div>
    </article>
  );
}

function MatchDetailModal({
  selected,
  onClose,
}: {
  selected: SelectedMatch;
  onClose: () => void;
}) {
  const { fixture, mode, markets } = selected;
  const liveFixture = mode === 'live' ? (fixture as LiveFixture) : null;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="match-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-modal-title"
        data-testid={`dialog-match-${fixture.id}`}
      >
        <button
          className="modal-close"
          type="button"
          onClick={onClose}
          aria-label="Fechar detalhes"
          data-testid="button-close-match-detail"
        >
          <X aria-hidden="true" />
        </button>

        <header className="modal-header">
          <span>{modeConfig[mode].label}</span>
          <h2 id="match-modal-title">
            {fixture.homeTeam} <small>vs</small> {fixture.awayTeam}
          </h2>
          <div className="modal-meta">
            <span>
              <Trophy aria-hidden="true" />
              {fixture.league} · {fixture.country}
            </span>
            <span>
              <Clock3 aria-hidden="true" />
              {formatFixtureDate(fixture.kickoff)} ·{' '}
              {formatKickoff(fixture.kickoff)}
            </span>
            {liveFixture && (
              <span className="modal-live-score">
                <Radio aria-hidden="true" />
                {liveFixture.homeScore} — {liveFixture.awayScore} ·{' '}
                {liveFixture.minute}'
              </span>
            )}
          </div>
        </header>

        <div className="modal-simulated-notice">
          <ShieldCheck aria-hidden="true" />
          <strong>ANÁLISE SIMULADA</strong>
          <span>
            {mode === 'live'
              ? 'Jogos, minuto e placar reais · Estatísticas, odds e sinais continuam simulados'
              : 'Jogos reais de hoje · Odds e estatísticas ainda simuladas — versão de teste'}
          </span>
        </div>

        <div className="modal-markets">
          {markets.map((market) => (
            <article className="modal-market" key={market.line}>
              <div className="modal-market-heading">
                <div>
                  <span>Sinal simulado</span>
                  <h3>{market.line}</h3>
                </div>
                <span
                  className={`confidence ${confidenceClass(market.confidence)}`}
                >
                  {market.confidence}
                </span>
              </div>
              <div className="modal-market-metrics">
                <Metric label="Odd" value={market.odds.toFixed(2)} />
                <Metric label="Prob." value={`${market.probability}%`} />
                <Metric label="Edge" value={`+${market.edge}%`} accent />
                <Metric
                  label="Média golos"
                  value={market.goalsAverage.toFixed(2)}
                />
                <Metric label="Forma" value={`${market.form}%`} />
              </div>
              <div className="modal-reasons">
                <strong>Razões do sinal</strong>
                <ul>
                  {market.factors.map((factor) => (
                    <li key={factor}>{factor}</li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function EmptyState({
  isError,
  isLive,
}: {
  isError: boolean;
  isLive: boolean;
}) {
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
        {isLive && !isError
          ? 'Nenhum jogo ao vivo neste momento — a atualizar automaticamente'
          : isError
          ? 'Não foi possível carregar os jogos'
          : 'Sem jogos disponíveis para hoje'}
      </h2>
      <p>
        {isLive && !isError
          ? 'A lista é verificada novamente a cada 20 minutos.'
          : isError
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
  const [selectedMatch, setSelectedMatch] = useState<SelectedMatch | null>(
    null,
  );
  const todayQuery = useGetTodayFixtures({
      query: {
        queryKey: getGetTodayFixturesQueryKey(),
        staleTime: TWO_HOURS,
        refetchInterval: TWO_HOURS,
      },
    });
  const liveQuery = useGetLiveFixtures({
    query: {
      queryKey: getGetLiveFixturesQueryKey(),
      staleTime: TWENTY_MINUTES,
      refetchInterval: TWENTY_MINUTES,
    },
  });

  const activeQuery = mode === 'live' ? liveQuery : todayQuery;
  const fixtures = useMemo<Array<Fixture | LiveFixture>>(
    () =>
      mode === 'live'
        ? (liveQuery.data?.fixtures ?? []).filter((fixture) =>
            isCurrentSystemDate(fixture.kickoff),
          )
        : (todayQuery.data?.fixtures ?? []),
    [liveQuery.data?.fixtures, mode, todayQuery.data?.fixtures],
  );
  const rankedFixtures = useMemo(
    () =>
      fixtures
        .map((fixture, originalIndex) => {
          const markets = buildMarketSignals(fixture.id, mode);
          const analysis = markets[0];
          return {
            fixture,
            analysis,
            markets,
            isFeatured: isFeaturedSignal(analysis),
            originalIndex,
          };
        })
        .sort((left, right) => {
          if (left.isFeatured !== right.isFeatured) {
            return left.isFeatured ? -1 : 1;
          }
          if (left.isFeatured && right.isFeatured) {
            return right.analysis.edge - left.analysis.edge;
          }
          return left.originalIndex - right.originalIndex;
        }),
    [fixtures, mode],
  );
  const displayDate =
    mode === 'live' ? undefined : todayQuery.data?.date;
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
              {formatDate(displayDate)}
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
              <strong>{activeQuery.isLoading ? '—' : fixtures.length}</strong>
            </div>
            <div>
              <span>Última lista</span>
              <strong>{formatUpdatedAt(activeQuery.data?.fetchedAt)}</strong>
            </div>
            <button
              type="button"
              onClick={() => void activeQuery.refetch()}
              disabled={activeQuery.isFetching}
              aria-label="Verificar lista em cache"
            >
              <RefreshCw
                className={activeQuery.isFetching ? 'spinning' : undefined}
                aria-hidden="true"
              />
            </button>
          </div>
        </section>

        <section className="data-notice" aria-label="Informação dos dados">
          <ShieldCheck aria-hidden="true" />
          <p>
            {mode === 'live'
              ? '⚠️ Jogos, minuto e placar reais · Estatísticas, odds e sinais continuam simulados'
              : '⚠️ Jogos reais de hoje · Odds e estatísticas ainda simuladas — versão de teste'}
          </p>
        </section>

        {(activeQuery.data?.stale || activeQuery.data?.warning) && (
          <div className="cache-warning" role="status">
            <RefreshCw aria-hidden="true" />
            <span>
              {activeQuery.data.warning ??
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

        {activeQuery.isLoading ? (
          <LoadingState />
        ) : fixtures.length === 0 ? (
          <EmptyState isError={activeQuery.isError} isLive={mode === 'live'} />
        ) : (
          <div className="cards-grid">
            {rankedFixtures.map(
              ({ fixture, analysis, markets, isFeatured }, index) => (
              <MatchCard
                fixture={fixture}
                mode={mode}
                index={index}
                analysis={analysis}
                isFeatured={isFeatured}
                onOpen={() => setSelectedMatch({ fixture, mode, markets })}
                key={`${mode}-${fixture.id}`}
              />
              ),
            )}
          </div>
        )}
      </main>

      {selectedMatch && (
        <MatchDetailModal
          selected={selectedMatch}
          onClose={() => setSelectedMatch(null)}
        />
      )}

      <footer>
        <div>
          <BarChart3 aria-hidden="true" />
          <span>
            Jogos fornecidos pela API-Football. Probabilidades, odds,
            estatísticas e sinais são simulações; minuto e placar são reais na
            secção Ao Vivo.
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