const SUPABASE_URL = "https://gpcdryucdqensomkbjpk.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwY2RyeXVjZHFlbnNvbWtianBrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5Mjk0NzY4OSwiZXhwIjoyMTA4NTIzNjg5fQ.oVRrsGUKV77ibBqF5g5S9V1A9W7D17WrcfO-PpeNr-c"; 

// 1. Lista das principais ligas da ESPN
const LIGAS = [
  { slug: 'bra.1', nomePadrao: 'Brazilian Serie A' },
  { slug: 'esp.1', nomePadrao: 'Spanish LALIGA' },
  { slug: 'eng.1', nomePadrao: 'English Premier League' },
  { slug: 'ita.1', nomePadrao: 'Italian Serie A' },
  { slug: 'ger.1', nomePadrao: 'German Bundesliga' },
  { slug: 'fra.1', nomePadrao: 'French Ligue 1' },
  { slug: 'uefa.champions', nomePadrao: 'UEFA Champions League' },
  { slug: 'uefa.europa', nomePadrao: 'UEFA Europa League' },
  { slug: 'conmebol.libertadores', nomePadrao: 'Copa Libertadores' },
  { slug: 'conmebol.sudamericana', nomePadrao: 'Copa Sudamericana' }
];

// 2. Anos para retroativo (Backfill)
const ANOS = [2021, 2022, 2023, 2024, 2025, 2026];

async function executarBackfillGeral() {
  console.log("🚀 Iniciando backfill completo de todos os campeonatos na ESPN...");
  
  // Mapa em memória para evitar IDs duplicados antes do envio
  const mapaJogos = new Map();

  for (const liga of LIGAS) {
    for (const ano of ANOS) {
      console.log(`⏳ Buscando ${liga.nomePadrao} (${liga.slug}) - Ano ${ano}...`);
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${liga.slug}/scoreboard?dates=${ano}&limit=1000`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`⚠️ Erro na resposta da ESPN para ${liga.slug} (${ano}): ${res.statusText}`);
          continue;
        }

        const data = await res.json();
        const eventos = data.events || [];

        if (eventos.length === 0) {
          console.log(`ℹ️ Nenhum jogo retornado para ${liga.slug} em ${ano}.`);
          continue;
        }

        let contagemNovos = 0;
        for (const evento of eventos) {
          const comp = evento.competitions?.[0];
          if (!comp) continue;

          const home = comp.competitors?.find(c => c.homeAway === 'home');
          const away = comp.competitors?.find(c => c.homeAway === 'away');
          const idEspn = evento.id.toString();

          // Ignora partidas sem id_espn válido
          if (!idEspn) continue;

          // Extração segura de estatísticas se disponíveis
          const getStat = (compObj, statName) => {
            const stats = compObj?.statistics || [];
            const st = stats.find(s => s.name === statName || s.label === statName);
            return parseInt(st?.displayValue || '0') || 0;
          };

          const jogoFormatado = {
            id_espn: idEspn,
            data_jogo: evento.date,
            campeonato: data.leagues?.[0]?.name || liga.nomePadrao,
            time_casa: home?.team?.displayName || 'Equipa Casa',
            time_fora: away?.team?.displayName || 'Equipa Fora',
            placar_casa: parseInt(home?.score || '0') || 0,
            placar_fora: parseInt(away?.score || '0') || 0,
            escanteios_casa: getStat(home, 'wonCorners'),
            escanteios_fora: getStat(away, 'wonCorners'),
            finalizacoes_casa: getStat(home, 'totalShots'),
            finalizacoes_fora: getStat(away, 'totalShots'),
            amarelos_casa: getStat(home, 'yellowCards'),
            amarelos_fora: getStat(away, 'yellowCards'),
            faltas_casa: getStat(home, 'foulsCommitted'),
            faltas_fora: getStat(away, 'foulsCommitted')
          };

          // Garante unicidade pelo id_espn em memória
          if (!mapaJogos.has(idEspn)) {
            mapaJogos.set(idEspn, jogoFormatado);
            contagemNovos++;
          }
        }

        console.log(`  ✓ ${contagemNovos} jogos capturados para ${liga.slug} (${ano}).`);
      } catch (err) {
        console.error(`❌ Erro ao processar ${liga.slug} (${ano}):`, err.message);
      }
    }
  }

  const todosJogos = Array.from(mapaJogos.values());
  console.log(`\n📦 Total de jogos únicos consolidados: ${todosJogos.length}. Gravando no Supabase em lotes...`);

  if (todosJogos.length > 0) {
    await salvarEmLotes(todosJogos);
  } else {
    console.log("⚠️ Nenhum jogo foi retornado para inserção.");
  }

  console.log("\n🎉 Processo de Backfill Geral Concluído com Sucesso!");
}

// Envia ao Supabase em lotes de 200 registros para evitar payload muito grande
async function salvarEmLotes(listaJogos, tamanhoLote = 200) {
  for (let i = 0; i < listaJogos.length; i += tamanhoLote) {
    const lote = listaJogos.slice(i, i + tamanhoLote);
    console.log(`⏳ Enviando lote ${Math.floor(i / tamanhoLote) + 1} de ${Math.ceil(listaJogos.length / tamanhoLote)} (${lote.length} registros)...`);

    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/jogos_campeonato?on_conflict=id_espn`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates' // Atualiza ou ignora duplicados com base no id_espn
        },
        body: JSON.stringify(lote)
      });

      if (response.ok) {
        console.log(`  ✅ Lote gravado com sucesso!`);
      } else {
        const errText = await response.text();
        console.error(`  ❌ Erro ao gravar lote no Supabase:`, errText);
      }
    } catch (err) {
      console.error(`  ❌ Falha na requisição do lote:`, err.message);
    }
  }
}

executarBackfillGeral();