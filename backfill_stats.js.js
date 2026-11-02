const SUPABASE_URL = "https://gpcdryucdqensomkbjpk.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwY2RyeXVjZHFlbnNvbWtianBrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5Mjk0NzY4OSwiZXhwIjoyMTA4NTIzNjg5fQ.oVRrsGUKV77ibBqF5g5S9V1A9W7D17WrcfO-PpeNr-c";

// 1. Mapeia o campeonato para a slug da liga na ESPN
function obterSlugLiga(campeonato) {
  if (!campeonato) return 'all';
  const c = campeonato.toLowerCase();
  if (c.includes('bra') || c.includes('brasileir')) return 'bra.1';
  if (c.includes('eng') || c.includes('premier')) return 'eng.1';
  if (c.includes('esp') || c.includes('laliga') || c.includes('la liga')) return 'esp.1';
  if (c.includes('ita') || c.includes('serie a') || c.includes('série a')) return 'ita.1';
  if (c.includes('ger') || c.includes('bundesliga')) return 'ger.1';
  if (c.includes('fra') || c.includes('ligue')) return 'fra.1';
  if (c.includes('champions') || c.includes('uefa')) return 'uefa.champions';
  if (c.includes('europa')) return 'uefa.europa';
  if (c.includes('libertadores')) return 'conmebol.libertadores';
  if (c.includes('sudamericana')) return 'conmebol.sudamericana';
  return 'all';
}

// 2. Utilitário para extrair valores das estatísticas do boxscore
function extrairEstatistica(statsArray, nomes) {
  if (!statsArray) return 0;
  const stat = statsArray.find(s => nomes.includes(s.name) || nomes.includes(s.abbreviation) || nomes.includes(s.label));
  return stat ? parseInt(stat.displayValue || stat.value || 0, 10) : 0;
}

// 3. Função Principal de Atualização dos Pendentes
async function atualizarApenasPendentes() {
  console.log("🚀 A procurar jogos pendentes no Supabase (gols_casa IS NULL)...");

  let processadosTotal = 0;
  let temPendentes = true;

  while (temPendentes) {
    // Busca até 100 jogos pendentes onde gols_casa ainda está NULL
    const resJogos = await fetch(`${SUPABASE_URL}/rest/v1/jogos_campeonato?select=id_espn,campeonato,placar_casa,placar_fora&gols_casa=is.null&limit=100`, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });

    if (!resJogos.ok) {
      console.error("❌ Erro ao ligar ao Supabase:", await resJogos.text());
      break;
    }

    const jogos = await resJogos.json();
    if (!Array.isArray(jogos) || jogos.length === 0) {
      console.log("🎉 Todos os jogos pendentes foram atualizados com sucesso!");
      temPendentes = false;
      break;
    }

    console.log(`⚡ A processar lote de ${jogos.length} jogos pendentes...`);

    for (let i = 0; i < jogos.length; i++) {
      const { id_espn: idEspn, campeonato, placar_casa, placar_fora } = jogos[i];
      const ligaSlug = obterSlugLiga(campeonato);
      
      let urlSummary = `https://site.api.espn.com/apis/site/v2/sports/soccer/${ligaSlug}/summary?event=${idEspn}`;
      let summaryRes = await fetch(urlSummary);

      // Fallback: se a rota específica da liga falhar (404), tenta na rota geral 'all'
      if (!summaryRes.ok && ligaSlug !== 'all') {
        urlSummary = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${idEspn}`;
        summaryRes = await fetch(urlSummary);
      }

      // Se não encontrar o evento na ESPN, marca como 'Sem registo' para evitar loop infinito
      if (!summaryRes.ok) {
        console.warn(`⚠️ [${idEspn}] Não foi encontrado resumo na ESPN. Marcando como 'Sem registo'...`);
        await fetch(`${SUPABASE_URL}/rest/v1/jogos_campeonato?id_espn=eq.${idEspn}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            gols_casa: 'Sem registo',
            gols_fora: 'Sem registo'
          })
        });
        continue;
      }

      try {
        const summaryData = await summaryRes.json();
        const boxscore = summaryData.boxscore;
        const comp = summaryData.header?.competitions?.[0] || summaryData.competitions?.[0];

        const homeComp = comp?.competitors?.find(c => c.homeAway === 'home');
        const awayComp = comp?.competitors?.find(c => c.homeAway === 'away');

        const homeTeamId = String(homeComp?.team?.id || homeComp?.id || boxscore?.teams?.find(t => t.homeAway === 'home')?.team?.id || '');
        const awayTeamId = String(awayComp?.team?.id || awayComp?.id || boxscore?.teams?.find(t => t.homeAway === 'away')?.team?.id || '');

        let homeStats = [], awayStats = [];
        if (boxscore && boxscore.teams && boxscore.teams.length >= 2) {
          const team0IsHome = String(boxscore.teams[0]?.team?.id || boxscore.teams[0]?.id) === homeTeamId || boxscore.teams[0]?.homeAway === 'home';
          homeStats = team0IsHome ? boxscore.teams[0]?.statistics : boxscore.teams[1]?.statistics;
          awayStats = team0IsHome ? boxscore.teams[1]?.statistics : boxscore.teams[0]?.statistics;
        }

        const rawEvents = [
          ...(summaryData.keyEvents || []),
          ...(summaryData.details || []),
          ...(summaryData.scoringPlays || []),
          ...(comp?.details || []),
          ...(summaryData.plays || [])
        ];

        let golsCasa = [], golsFora = [];
        let amarelosCasa = [], amarelosFora = [];
        let vermelhosCasa = [], vermelhosFora = [];

        for (const d of rawEvents) {
          const typeStr = [
            d.type?.text,
            d.type?.displayName,
            d.type?.shortName,
            d.text,
            d.shortText,
            d.playType?.text
          ].filter(Boolean).join(' ').toLowerCase();

          const eventTeamId = String(d.team?.id || d.teamId || d.competitorId || '');
          let isHome = (eventTeamId === homeTeamId);
          let isAway = (eventTeamId === awayTeamId);

          if (!isHome && !isAway) {
            if (d.team?.homeAway === 'home' || d.homeAway === 'home') isHome = true;
            else if (d.team?.homeAway === 'away' || d.homeAway === 'away') isAway = true;
          }

          let atleta = d.athletesInvolved?.[0]?.displayName ||
                       d.participants?.[0]?.athlete?.displayName ||
                       d.athlete?.displayName ||
                       d.athleteName;

          if (!atleta && d.text) {
            atleta = d.text.split('(')[0].replace(/Goal!|Yellow Card|Red Card|Penalty/gi, '').trim();
          }
          if (!atleta) atleta = 'Jogador';

          const min = d.clock?.displayValue || d.time?.displayValue || (d.clock?.value ? `${d.clock.value}'` : '');
          const tempo = min ? ` (${min.toString().replace("'", "")}')` : '';
          const registro = `${atleta}${tempo}`;

          const isGoal = typeStr.includes('goal') || typeStr.includes('golo') || typeStr.includes('gol') || d.scoringPlay === true;
          const isYellow = typeStr.includes('yellow') || typeStr.includes('amarelo');
          const isRed = typeStr.includes('red') || typeStr.includes('vermelho');

          if (isGoal) {
            if (isHome) golsCasa.push(registro);
            else if (isAway) golsFora.push(registro);
          } else if (isYellow) {
            if (isHome) amarelosCasa.push(registro);
            else if (isAway) amarelosFora.push(registro);
          } else if (isRed) {
            if (isHome) vermelhosCasa.push(registro);
            else if (isAway) vermelhosFora.push(registro);
          }
        }

        golsCasa = [...new Set(golsCasa)];
        golsFora = [...new Set(golsFora)];
        amarelosCasa = [...new Set(amarelosCasa)];
        amarelosFora = [...new Set(amarelosFora)];
        vermelhosCasa = [...new Set(vermelhosCasa)];
        vermelhosFora = [...new Set(vermelhosFora)];

        const dadosAtualizados = {
          escanteios_casa: extrairEstatistica(homeStats, ['wonCorners', 'corners']),
          escanteios_fora: extrairEstatistica(awayStats, ['wonCorners', 'corners']),
          finalizacoes_casa: extrairEstatistica(homeStats, ['totalShots', 'shots']),
          finalizacoes_fora: extrairEstatistica(awayStats, ['totalShots', 'shots']),
          amarelos_casa: extrairEstatistica(homeStats, ['yellowCards']),
          amarelos_fora: extrairEstatistica(awayStats, ['yellowCards']),
          faltas_casa: extrairEstatistica(homeStats, ['foulsCommitted', 'fouls']),
          faltas_fora: extrairEstatistica(awayStats, ['foulsCommitted', 'fouls']),
          gols_casa: golsCasa.length > 0 ? golsCasa.join(', ') : (placar_casa === 0 ? 'Nenhum' : 'Sem registo'),
          gols_fora: golsFora.length > 0 ? golsFora.join(', ') : (placar_fora === 0 ? 'Nenhum' : 'Sem registo'),
          amarelos_jogadores_casa: amarelosCasa.join(', ') || 'Nenhum',
          amarelos_jogadores_fora: amarelosFora.join(', ') || 'Nenhum',
          vermelhos_jogadores_casa: vermelhosCasa.join(', ') || 'Nenhum',
          vermelhos_jogadores_fora: vermelhosFora.join(', ') || 'Nenhum'
        };

        await fetch(`${SUPABASE_URL}/rest/v1/jogos_campeonato?id_espn=eq.${idEspn}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(dadosAtualizados)
        });

        processadosTotal++;
        console.log(`[${processadosTotal}] ✅ Jogo ${idEspn} | Golos C: [${dadosAtualizados.gols_casa}] | Golos F: [${dadosAtualizados.gols_fora}]`);

      } catch (err) {
        console.error(`❌ Erro ao processar dados do jogo ${idEspn}:`, err.message);
      }

      // Pequena pausa entre requisições para evitar rate limit na API
      await new Promise(r => setTimeout(r, 150));
    }
  }
}

atualizarApenasPendentes();