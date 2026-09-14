import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Bell,
  BellRing,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  History,
  Goal,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Star,
  TimerReset,
  Trophy,
  X,
  XCircle,
} from 'lucide-react';
import {
  getGetSignalHistoryQueryKey,
  getGetLiveFixturesQueryKey,
  getGetTodayFixturesQueryKey,
  getGetVapidPublicKeyQueryKey,
  useGetLiveFixtures,
  useGetSignalHistory,
  useGetVapidPublicKey,
  useSubscribePush,
  useGetTodayFixtures,
  useRegisterFeaturedSignals,
  useUpdateFavoriteIds,
  type Fixture,
  type LiveFixture,
  type SignalHistoryItem,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const TWO_HOURS = 2 * 60 * 60 * 1000;
const TWENTY_MINUTES = 20 * 60 * 1000;
const HIGH_EDGE_THRESHOLD = 30;
const HIGH_PROB_THRESHOLD = 70;
const TOP_OPPORTUNITIES_LIMIT = 18;

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

type ViewMode = MarketMode | 'opportunities' | 'favorites' | 'history';

type FavoriteMatch = {
  fixture: Fixture | LiveFixture;
  mode: MarketMode;
  savedAt: string;
};

const FAVORITES_STORAGE_KEY = 'radar-de-golos:favorites';
const NOTIFICATIONS_STORAGE_KEY = 'radar-de-golos:notifications-enabled';

const modeConfig: Record<
  ViewMode,
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
  opportunities: {
    label: 'Melhores Oportunidades',
    shortLabel: 'Melhores',
    description: 'Top sinais de todas as secções, ordenados por edge',
    icon: Sparkles,
  },
  favorites: {
    label: 'Favoritos',
    shortLabel: 'Favoritos',
    description: 'Jogos guardados neste dispositivo',
    icon: Star,
  },
  history: {
    label: 'Histórico',
    shortLabel: 'Histórico',
    description: 'Acertividade dos sinais comparada com resultados reais',
    icon: History,
  },
};

const TERMINAL_FIXTURE_STATUSES = new Set([
  'FT',
  'AET',
  'PEN',
  'CANC',
  'ABD',
  'PST',
  'SUSP',
  'INT',
  'AWD',
  'WO',
]);

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
    analysis.confidence === 'Alta' &&
    (analysis.edge >= HIGH_EDGE_THRESHOLD ||
      analysis.probability >= HIGH_PROB_THRESHOLD)
  );
}

function loadFavorites(): FavoriteMatch[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value) as FavoriteMatch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
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
  isFavorite,
  onToggleFavorite,
  isArchived,
  sourceLabel,
}: {
  fixture: Fixture | LiveFixture;
  mode: MarketMode;
  index: number;
  analysis: SimulatedAnalysis;
  isFeatured: boolean;
  onOpen: () => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  isArchived?: boolean;
  sourceLabel?: string;
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
      <button
        className={`favorite-button${isFavorite ? ' is-favorite' : ''}`}
        type="button"
        aria-label={
          isFavorite ? 'Remover jogo dos favoritos' : 'Adicionar jogo aos favoritos'
        }
        aria-pressed={isFavorite}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite();
        }}
        data-testid={`button-favorite-${fixture.id}`}
      >
        <Star aria-hidden="true" fill={isFavorite ? 'currentColor' : 'none'} />
      </button>
      {(isFeatured || isArchived) && (
        <div className="card-status-badges">
          {isFeatured && (
            <div className="featured-signal-badge">
              <Sparkles aria-hidden="true" />
              Sinal em Destaque
            </div>
          )}
          {isArchived && (
            <div className="archived-match-badge">Jogo terminado</div>
          )}
        </div>
      )}
      {sourceLabel && (
        <div className="opportunity-source-badge">
          Origem: {sourceLabel}
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
  warning,
}: {
  isError: boolean;
  isLive: boolean;
  warning?: string | null;
}) {
  const isQuotaExhausted =
    warning === 'Quota diária esgotada, aguarde amanhã';

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
        {isQuotaExhausted
          ? 'Quota diária esgotada, aguarde amanhã'
          : isLive && !isError
          ? 'Nenhum jogo ao vivo neste momento — a atualizar automaticamente'
          : isError
          ? 'Não foi possível carregar os jogos'
          : 'Sem jogos disponíveis para hoje'}
      </h2>
      <p>
        {isQuotaExhausted
          ? 'A API-Football recusou o pedido com o status HTTP 429.'
          : isLive && !isError
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

function marketLabel(market: MarketMode): string {
  return modeConfig[market].label;
}

function AccuracyMetric({
  label,
  signals,
}: {
  label: string;
  signals: SignalHistoryItem[];
}) {
  const hits = signals.filter((signal) => signal.outcome === 'hit').length;
  const percentage =
    signals.length > 0 ? Math.round((hits / signals.length) * 100) : 0;
  return (
    <div className="accuracy-metric">
      <span>{label}</span>
      <strong>{signals.length > 0 ? `${percentage}%` : '—'}</strong>
      <small>
        {signals.length > 0
          ? `${hits} de ${signals.length} sinais resolvidos`
          : 'Sem sinais resolvidos'}
      </small>
    </div>
  );
}

function HistoryView({
  signals,
  isLoading,
  isError,
}: {
  signals: SignalHistoryItem[];
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) return <LoadingState />;
  if (isError) {
    return (
      <div className="empty-state">
        <h2>Não foi possível carregar o histórico</h2>
        <p>Tente novamente dentro de alguns instantes.</p>
      </div>
    );
  }

  const pending = signals.filter((signal) => signal.outcome === null);
  const resolved = signals
    .filter((signal) => signal.outcome !== null)
    .sort(
      (left, right) =>
        new Date(right.resolvedAt ?? 0).getTime() -
        new Date(left.resolvedAt ?? 0).getTime(),
    );

  return (
    <div className="history-content">
      <div className="history-warning">
        Sinal simulado comparado com resultado real do jogo — amostra ainda
        pequena, não é garantia de desempenho futuro.
      </div>
      <div className="accuracy-grid">
        <AccuracyMetric label="Geral" signals={resolved} />
        {(['full', 'firstHalf', 'live'] as MarketMode[]).map((market) => (
          <AccuracyMetric
            key={market}
            label={marketLabel(market)}
            signals={resolved.filter((signal) => signal.market === market)}
          />
        ))}
      </div>
      <div className="pending-summary" data-testid="history-pending-count">
        <Clock3 aria-hidden="true" />
        <strong>{pending.length}</strong>{' '}
        {pending.length === 1 ? 'sinal pendente' : 'sinais pendentes'}
      </div>
      {resolved.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <History aria-hidden="true" />
          </div>
          <h2>Ainda não existem sinais resolvidos</h2>
          <p>Os resultados aparecem aqui quando os jogos terminarem.</p>
        </div>
      ) : (
        <div className="history-list">
          {resolved.map((signal) => (
            <article
              className={`history-row ${signal.outcome}`}
              key={signal.id}
            >
              <div className="history-outcome">
                {signal.outcome === 'hit' ? (
                  <CheckCircle2 aria-hidden="true" />
                ) : (
                  <XCircle aria-hidden="true" />
                )}
              </div>
              <div className="history-match">
                <span>{marketLabel(signal.market)}</span>
                <h3>
                  {signal.homeTeam} <small>vs</small> {signal.awayTeam}
                </h3>
                <time dateTime={signal.resolvedAt ?? undefined}>
                  {signal.resolvedAt
                    ? new Intl.DateTimeFormat('pt-PT', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      }).format(new Date(signal.resolvedAt))
                    : ''}
                </time>
              </div>
              <div className="history-result">
                <span>{signal.line}</span>
                <strong>{signal.realResult}</strong>
                <small>
                  Edge +{signal.edge.toFixed(1)}% · {signal.probability}%
                </small>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function LocalDateTime() {
  const [now, setNow] = useState(() => new Date());
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

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const time = now.toLocaleTimeString('pt-PT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const date = `${String(now.getDate()).padStart(2, '0')} ${
    monthNames[now.getMonth()]
  } ${now.getFullYear()}`;

  return (
    <time className="local-date-time" dateTime={now.toISOString()}>
      <span>{time}</span>
      <span>{date}</span>
    </time>
  );
}

function Dashboard() {
  const [mode, setMode] = useState<ViewMode>('full');
  const [favorites, setFavorites] = useState<FavoriteMatch[]>(loadFavorites);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () =>
      typeof Notification !== 'undefined' &&
      window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === 'true' &&
      Notification.permission === 'granted',
  );
  const [notificationError, setNotificationError] = useState<string | null>(
    null,
  );
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
      refetchInterval: mode === 'live' ? TWENTY_MINUTES : false,
    },
  });
  const historyQuery = useGetSignalHistory({
    query: {
      queryKey: getGetSignalHistoryQueryKey(),
      enabled: mode === 'history',
      staleTime: 60_000,
    },
  });
  const vapidQuery = useGetVapidPublicKey({
    query: {
      queryKey: getGetVapidPublicKeyQueryKey(),
      enabled: mode === 'favorites',
      staleTime: Infinity,
    },
  });
  const subscribePushMutation = useSubscribePush();
  const updateFavoriteIdsMutation = useUpdateFavoriteIds();
  const registerSignalsMutation = useRegisterFeaturedSignals();

  useEffect(() => {
    if (mode === 'live') {
      void liveQuery.refetch();
    }
  }, [mode]);

  useEffect(() => {
    if (liveQuery.data) {
      console.log('[Ao Vivo filtro por data]', {
        beforeFilter: liveQuery.data.sourceCount,
        afterFilter: liveQuery.data.liveCount,
      });
    }
    for (const fixture of liveQuery.data?.fixtures ?? []) {
      console.log('[Ao Vivo minuto: API → interface]', {
        fixtureId: fixture.id,
        apiMinute: fixture.apiMinute,
        interfaceMinute: fixture.minute,
      });
    }
  }, [liveQuery.data]);

  useEffect(() => {
    window.localStorage.setItem(
      FAVORITES_STORAGE_KEY,
      JSON.stringify(favorites),
    );
  }, [favorites]);

  useEffect(() => {
    const registrations = [
      ...(todayQuery.data?.fixtures ?? []).flatMap((fixture) =>
        (['full', 'firstHalf'] as MarketMode[]).map((market) => ({
          fixture,
          market,
          analysis: buildMarketSignals(fixture.id, market)[0],
        })),
      ),
      ...(liveQuery.data?.fixtures ?? []).map((fixture) => ({
        fixture,
        market: 'live' as const,
        analysis: buildMarketSignals(fixture.id, 'live')[0],
      })),
    ]
      .filter(
        ({ fixture, analysis }) =>
          !TERMINAL_FIXTURE_STATUSES.has(fixture.status) &&
          isFeaturedSignal(analysis),
      )
      .map(({ fixture, market, analysis }) => ({
        fixtureId: fixture.id,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        market,
        line: analysis.line,
        edge: analysis.edge,
        probability: analysis.probability,
      }));

    if (registrations.length === 0) return;
    void registerSignalsMutation
      .mutateAsync({ data: { signals: registrations } })
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: getGetSignalHistoryQueryKey(),
        }),
      )
      .catch(() => undefined);
  }, [liveQuery.data?.fixtures, todayQuery.data?.fixtures]);

  useEffect(() => {
    void updateFavoriteIdsMutation
      .mutateAsync({
        data: { fixtureIds: favorites.map((favorite) => favorite.fixture.id) },
      })
      .catch(() => {
        setNotificationError(
          'Não foi possível sincronizar os favoritos para notificações.',
        );
      });
  }, [favorites]);

  const enableNotifications = async () => {
    setNotificationError(null);
    try {
      if (
        typeof Notification === 'undefined' ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window)
      ) {
        throw new Error('unsupported');
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('permission');

      const publicKey =
        vapidQuery.data?.publicKey ?? (await vapidQuery.refetch()).data?.publicKey;
      if (!publicKey) throw new Error('missing-key');

      const registration =
        (await navigator.serviceWorker.getRegistration()) ??
        (await navigator.serviceWorker.register('/sw.js'));
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      const serialized = subscription.toJSON();
      if (
        !serialized.endpoint ||
        !serialized.keys?.p256dh ||
        !serialized.keys.auth
      ) {
        throw new Error('invalid-subscription');
      }
      await subscribePushMutation.mutateAsync({
        data: {
          endpoint: serialized.endpoint,
          expirationTime: serialized.expirationTime ?? null,
          keys: {
            p256dh: serialized.keys.p256dh,
            auth: serialized.keys.auth,
          },
        },
      });
      window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, 'true');
      setNotificationsEnabled(true);
    } catch (error) {
      setNotificationsEnabled(false);
      window.localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      setNotificationError(
        error instanceof Error && error.message === 'permission'
          ? 'A permissão de notificações não foi concedida.'
          : 'Não foi possível ativar as notificações neste navegador.',
      );
    }
  };

  const activeQuery = mode === 'live' ? liveQuery : todayQuery;
  const currentFixtureIds = useMemo(
    () =>
      new Set([
        ...(todayQuery.data?.fixtures ?? []).map((fixture) => fixture.id),
        ...(liveQuery.data?.fixtures ?? []).map((fixture) => fixture.id),
      ]),
    [liveQuery.data?.fixtures, todayQuery.data?.fixtures],
  );
  const displayItems = useMemo<
    Array<{
      fixture: Fixture | LiveFixture;
      analysisMode: MarketMode;
      isArchived: boolean;
    }>
  >(
    () => {
      if (mode === 'history') return [];
      if (mode === 'favorites') {
        return favorites.map((favorite) => ({
          fixture: favorite.fixture,
          analysisMode: favorite.mode,
          isArchived: !currentFixtureIds.has(favorite.fixture.id),
        }));
      }

      if (mode === 'opportunities') {
        const todayFixtures = todayQuery.data?.fixtures ?? [];
        const liveFixtures = (liveQuery.data?.fixtures ?? []).filter((fixture) =>
          isCurrentSystemDate(fixture.kickoff),
        );

        return [
          ...todayFixtures.map((fixture) => ({
            fixture,
            analysisMode: 'full' as const,
            isArchived: false,
          })),
          ...todayFixtures.map((fixture) => ({
            fixture,
            analysisMode: 'firstHalf' as const,
            isArchived: false,
          })),
          ...liveFixtures.map((fixture) => ({
            fixture,
            analysisMode: 'live' as const,
            isArchived: false,
          })),
        ];
      }

      const fixtures =
        mode === 'live'
        ? (liveQuery.data?.fixtures ?? []).filter((fixture) =>
            isCurrentSystemDate(fixture.kickoff),
          )
        : (todayQuery.data?.fixtures ?? []);
      return fixtures.map((fixture) => ({
        fixture,
        analysisMode: mode,
        isArchived: false,
      }));
    },
    [
      currentFixtureIds,
      favorites,
      liveQuery.data?.fixtures,
      mode,
      todayQuery.data?.fixtures,
    ],
  );
  const rankedFixtures = useMemo(
    () => {
      const ranked = displayItems
        .map(({ fixture, analysisMode, isArchived }, originalIndex) => {
          const markets = buildMarketSignals(fixture.id, analysisMode);
          const analysis = markets[0];
          return {
            fixture,
            analysisMode,
            analysis,
            markets,
            isArchived,
            isFeatured: isFeaturedSignal(analysis),
            originalIndex,
          };
        })
        .sort((left, right) => {
          if (mode === 'opportunities') {
            const edgeDifference =
              right.analysis.edge - left.analysis.edge;
            if (edgeDifference !== 0) return edgeDifference;
            if (left.analysis.confidence !== right.analysis.confidence) {
              if (left.analysis.confidence === 'Alta') return -1;
              if (right.analysis.confidence === 'Alta') return 1;
            }
            return left.originalIndex - right.originalIndex;
          }
          if (left.isFeatured !== right.isFeatured) {
            return left.isFeatured ? -1 : 1;
          }
          if (left.isFeatured && right.isFeatured) {
            return right.analysis.edge - left.analysis.edge;
          }
          return left.originalIndex - right.originalIndex;
        });

      return mode === 'opportunities'
        ? ranked.slice(0, TOP_OPPORTUNITIES_LIMIT)
        : ranked;
    },
    [displayItems, mode],
  );
  const displayDate =
    mode === 'live' ||
    mode === 'favorites' ||
    mode === 'opportunities' ||
    mode === 'history'
      ? undefined
      : todayQuery.data?.date;
  const ModeIcon = modeConfig[mode].icon;
  const isLoading =
    mode === 'history'
      ? historyQuery.isLoading
      : mode === 'favorites'
      ? false
      : mode === 'opportunities'
        ? todayQuery.isLoading || liveQuery.isLoading
        : activeQuery.isLoading;
  const isError =
    mode === 'history'
      ? historyQuery.isError
      : mode === 'favorites'
      ? false
      : mode === 'opportunities'
        ? todayQuery.isError && liveQuery.isError
        : activeQuery.isError;
  const fixtureCount = rankedFixtures.length;
  const historySignals = historyQuery.data?.signals ?? [];
  const displayCount =
    mode === 'history' ? historySignals.length : fixtureCount;

  const toggleFavorite = (
    fixture: Fixture | LiveFixture,
    analysisMode: MarketMode,
  ) => {
    setFavorites((current) => {
      const exists = current.some((favorite) => favorite.fixture.id === fixture.id);
      if (exists) {
        return current.filter((favorite) => favorite.fixture.id !== fixture.id);
      }
      return [
        ...current,
        { fixture, mode: analysisMode, savedAt: new Date().toISOString() },
      ];
    });
  };

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
          <div className="status-label">
            <span className="status-dot" aria-hidden="true" />
            <span className="status-copy">Dados reais ativos</span>
          </div>
          <LocalDateTime />
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
              <strong>{isLoading ? '—' : fixtureCount}</strong>
            </div>
            <div>
              <span>Última lista</span>
              <strong>{formatUpdatedAt(activeQuery.data?.fetchedAt)}</strong>
            </div>
            <button
              type="button"
              onClick={() => {
                if (mode !== 'favorites' && mode !== 'opportunities') {
                  void activeQuery.refetch();
                }
              }}
              disabled={
                mode === 'favorites' ||
                mode === 'opportunities' ||
                activeQuery.isFetching
              }
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
            {mode === 'history'
              ? 'Resultados reais usados apenas para medir sinais simulados já registados'
              : mode === 'live'
              ? '⚠️ Jogos, minuto e placar reais · Estatísticas, odds e sinais continuam simulados'
              : '⚠️ Jogos reais de hoje · Odds e estatísticas ainda simuladas — versão de teste'}
          </p>
        </section>

        {mode !== 'history' &&
          (activeQuery.data?.stale || activeQuery.data?.warning) && (
          <div className="cache-warning" role="status">
            <RefreshCw aria-hidden="true" />
            <span>
              {activeQuery.data.warning ??
                'não foi possível atualizar os jogos — usando última lista válida'}
            </span>
          </div>
          )}

        <nav className="mode-tabs" aria-label="Período de análise">
          {(Object.keys(modeConfig) as ViewMode[]).map((item) => {
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
            <span>
              {mode === 'history'
                ? 'Desempenho observado'
                : 'Análise simulada'}
            </span>
            <h2>{modeConfig[mode].label}</h2>
            <p>{modeConfig[mode].description}</p>
          </div>
          <div className="section-pill">
            <Sparkles aria-hidden="true" />
            {displayCount}{' '}
            {mode === 'history'
              ? displayCount === 1
                ? 'sinal'
                : 'sinais'
              : displayCount === 1
                ? 'jogo'
                : 'jogos'}
          </div>
        </section>

        {mode === 'favorites' && (
          <div className="notifications-panel">
            <button
              type="button"
              className={notificationsEnabled ? 'is-enabled' : undefined}
              onClick={() => void enableNotifications()}
              disabled={
                notificationsEnabled ||
                subscribePushMutation.isPending ||
                vapidQuery.isLoading
              }
              data-testid="button-enable-notifications"
            >
              {notificationsEnabled ? (
                <BellRing aria-hidden="true" />
              ) : (
                <Bell aria-hidden="true" />
              )}
              {notificationsEnabled
                ? 'Notificações ativadas ✓'
                : subscribePushMutation.isPending
                  ? 'A ativar notificações…'
                  : 'Ativar notificações'}
            </button>
            <p>
              Alertas de golos e cartões apenas para jogos favoritos ao vivo.
            </p>
            {notificationError && (
              <span role="status" data-testid="status-notification-error">
                {notificationError}
              </span>
            )}
          </div>
        )}

        {mode === 'history' ? (
          <HistoryView
            signals={historySignals}
            isLoading={isLoading}
            isError={isError}
          />
        ) : isLoading ? (
          <LoadingState />
        ) : fixtureCount === 0 ? (
          mode === 'favorites' ? (
            <div className="empty-state" data-testid="status-empty-favorites">
              <div className="empty-icon">
                <Star aria-hidden="true" />
              </div>
              <h2>Ainda não existem jogos favoritos</h2>
              <p>Use a estrela num card para o guardar neste dispositivo.</p>
            </div>
          ) : (
            <EmptyState
              isError={isError}
              isLive={mode === 'live'}
              warning={activeQuery.data?.warning}
            />
          )
        ) : (
          <div className="cards-grid">
            {rankedFixtures.map(
              (
                {
                  fixture,
                  analysisMode,
                  analysis,
                  markets,
                  isFeatured,
                  isArchived,
                },
                index,
              ) => (
              <MatchCard
                fixture={fixture}
                mode={analysisMode}
                index={index}
                analysis={analysis}
                isFeatured={isFeatured}
                isArchived={isArchived}
                sourceLabel={
                  mode === 'opportunities'
                    ? modeConfig[analysisMode].label
                    : undefined
                }
                isFavorite={favorites.some(
                  (favorite) => favorite.fixture.id === fixture.id,
                )}
                onToggleFavorite={() =>
                  toggleFavorite(fixture, analysisMode)
                }
                onOpen={() =>
                  setSelectedMatch({
                    fixture,
                    mode: analysisMode,
                    markets,
                  })
                }
                key={`${mode}-${analysisMode}-${fixture.id}`}
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