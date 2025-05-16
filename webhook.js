const admin = require('firebase-admin');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { OpenAI } = require('openai');
const fetch = require('node-fetch');
const { onRequest } = require('firebase-functions/v2/https');
const { Buffer } = require('buffer');
const { Blob, File } = require('buffer');
// Importar funções do whatsappService.js - GARANTIR QUE normalizarTelefoneBrasil ESTÁ AQUI
const { enviarMensagemWhatsApp, normalizarTelefoneBrasil } = require("./whatsappService.js"); // Ajuste o caminho se necessário

console.log('🚀 Iniciando inicialização do webhook...');

// Adicionando a função gerarRelatorio aqui
async function gerarRelatorio(periodo, igrejaId, dataInicioCustom = null, dataFimCustom = null) { // <<< ADICIONADO igrejaId AQUI
  console.log(`📊 Gerando relatório ${periodo} para Igreja ID: ${igrejaId}`);
  const agora = new Date();
  let dataInicio, dataFim;

  // Função auxiliar para converter string DD/MM/AAAA para Date
  const parseDate = (dateString) => {
    if (!dateString || typeof dateString !== 'string') return null;
    const parts = dateString.split('/');
    if (parts.length === 3) {
      // Mês é 0-indexado no construtor Date(ano, mês, dia)
      return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    }
    return null;
  };

  // Definir o intervalo de datas com base no período
  if (periodo === "personalizado" && dataInicioCustom && dataFimCustom) {
    dataInicio = parseDate(dataInicioCustom);
    dataFim = parseDate(dataFimCustom);
    // Ajustar dataFim para incluir o dia inteiro (até 23:59:59.999)
    if (dataFim) {
        dataFim.setHours(23, 59, 59, 999);
    }
    if (!dataInicio || !dataFim) {
        console.error(`  -> Datas personalizadas inválidas: ${dataInicioCustom}, ${dataFimCustom}`);
        return "❌ Datas personalizadas inválidas. Use o formato DD/MM/AAAA.";
    }
    console.log(`  -> Período personalizado: ${dataInicio.toISOString()} a ${dataFim.toISOString()}`);

  } else {
    dataFim = agora; // Fim é sempre agora para períodos não personalizados
    if (periodo === "hoje") {
        dataInicio = new Date(agora);
        dataInicio.setHours(0, 0, 0, 0); // Começo do dia de hoje
    } else if (periodo === "semanal" || periodo === "semana_atual") { // Adicionado semana_atual
      dataInicio = new Date(agora);
      dataInicio.setDate(agora.getDate() - agora.getDay()); // Vai para o último domingo
      dataInicio.setHours(0, 0, 0, 0);
    } else if (periodo === "mes_atual") { // Adicionado mes_atual
        dataInicio = new Date(agora.getFullYear(), agora.getMonth(), 1);
        dataInicio.setHours(0, 0, 0, 0);
    } else if (periodo === "ultimos_7_dias") {
        dataInicio = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (periodo === "ultimos_15_dias") {
        dataInicio = new Date(agora.getTime() - 15 * 24 * 60 * 60 * 1000);
    } else if (periodo === "ultimos_30_dias") {
        dataInicio = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (periodo === "ano_atual") {
        dataInicio = new Date(agora.getFullYear(), 0, 1);
        dataInicio.setHours(0, 0, 0, 0);
    } else {
      console.error(`  -> Período inválido solicitado: ${periodo}`);
      return "❌ Período inválido. Use: hoje, semana_atual, mes_atual, ultimos_7_dias, ultimos_15_dias, ultimos_30_dias, ano_atual ou personalizado DD/MM/AAAA DD/MM/AAAA.";
    }
    console.log(`  -> Período ${periodo}: ${dataInicio.toISOString()} a ${dataFim.toISOString()}`);
  }

  try {
    // --- MODIFICAÇÃO FIRESTORE: Buscar transações na subcoleção da igreja correta ---
    const transacoesQuery = db.collection("igrejas").doc(igrejaId).collection("transacoes")
      .where("data", ">=", Timestamp.fromDate(dataInicio)) // Usa Timestamp para comparação
      .where("data", "<=", Timestamp.fromDate(dataFim))
      .orderBy("data", "asc"); // Ordena por data para clareza no relatório
      
    const transacoesSnap = await transacoesQuery.get();
    console.log(`  -> Consulta Firestore: /igrejas/${igrejaId}/transacoes entre ${dataInicio.toLocaleDateString("pt-BR")} e ${dataFim.toLocaleDateString("pt-BR")}. Encontradas: ${transacoesSnap.size} transações.`);

    let totalEntradas = 0;
    let totalSaidas = 0;
    let listaTransacoes = "";
    let contadorTransacoes = 0;
    const limiteTransacoesListadas = 30; // Limite para não estourar a mensagem do WhatsApp

    transacoesSnap.forEach(doc => {
      const transacao = doc.data();
      const valor = parseFloat(transacao.valor) || 0;
      const tipo = transacao.tipo;
      const membro = transacao.membro || "Não informado";
      const descricao = transacao.descricao || "Sem descrição";
      // Converte Timestamp do Firestore para Date do JS para formatar
      const dataTransacao = transacao.data.toDate ? transacao.data.toDate() : new Date(); 
      const dataFormatada = dataTransacao.toLocaleDateString("pt-BR");

      if (tipo === "entrada") {
        totalEntradas += valor;
        if (contadorTransacoes < limiteTransacoesListadas) {
            listaTransacoes += `📥 ${dataFormatada}: +R$ ${valor.toFixed(2)} (${descricao} - ${membro})\n`;
            contadorTransacoes++;
        }
      } else if (tipo === "saida") { // Corrigido para 'saida'
        totalSaidas += valor;
        if (contadorTransacoes < limiteTransacoesListadas) {
            listaTransacoes += `📤 ${dataFormatada}: -R$ ${valor.toFixed(2)} (${descricao} - ${membro})\n`;
            contadorTransacoes++;
        }
      }
    });

    // Monta a resposta final
    let resposta = `📊 Relatório ${periodo.charAt(0).toUpperCase() + periodo.slice(1)}
`;
    resposta += `⛪ Igreja ID: ${igrejaId}\n`; // Adiciona o ID da igreja
    resposta += `📅 Período: ${dataInicio.toLocaleDateString("pt-BR")} a ${dataFim.toLocaleDateString("pt-BR")}\n\n`;
    
    if (transacoesSnap.empty) {
        resposta += "ℹ️ Nenhuma transação encontrada no período.\n";
    } else {
        resposta += listaTransacoes;
        if (contadorTransacoes >= limiteTransacoesListadas) {
            resposta += `\n... (e mais ${transacoesSnap.size - limiteTransacoesListadas} transações)`;
        }
    }

    resposta += `\n💰 Total Entradas: R$ ${totalEntradas.toFixed(2)}\n`;
    resposta += `💸 Total Saídas: R$ ${totalSaidas.toFixed(2)}\n`;
    resposta += `⚖️ Saldo do Período: R$ ${(totalEntradas - totalSaidas).toFixed(2)}\n`;

    console.log(`  -> Relatório gerado com sucesso.`);
    return resposta;

  } catch (error) {
    console.error(`❌ Erro ao gerar relatório para igreja ${igrejaId}:`, error);
    // Retorna uma mensagem de erro para ser enviada ao WhatsApp
    return "❌ Ocorreu um erro ao buscar os dados para gerar o relatório. Tente novamente.";
  }
}

console.log('🔍 Verificando inicialização do Firebase Admin...');
console.log('FieldValue disponível:', !!FieldValue);
console.log('Timestamp disponível:', !!Timestamp);

const db = getFirestore();

// Inicializar OpenAI
let openai;
try {
  console.log('🔑 Verificando OPENAI_API_KEY...');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('❌ OPENAI_API_KEY não está configurada no ambiente.');
    throw new Error('OPENAI_API_KEY não está configurada no ambiente. Configure-a usando firebase functions:config:set openai.api_key="sua-chave-aqui"');
  }
  console.log('✅ OPENAI_API_KEY encontrada:', apiKey.substring(0, 5) + '...');
  openai = new OpenAI({
    apiKey: apiKey,
  });
  console.log('✅ OpenAI inicializado com sucesso.');
} catch (error) {
  console.error('❌ Erro ao inicializar OpenAI:', error.message);
  throw error;
}

console.log('🌐 Verificando porta do ambiente...');
const port = process.env.PORT || 8080;
console.log(`🌐 Porta configurada: ${port}`);

// --- REMOVIDA A FUNÇÃO normalizarTelefoneBrasil DUPLICADA DAQUI ---
// A função agora é importada do whatsappService.js no topo do arquivo.

function gerarIdentificador() {
  const letras = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numeros = "0123456789";
  const partes = [
    letras[Math.floor(Math.random() * letras.length)],
    letras[Math.floor(Math.random() * letras.length)],
    letras[Math.floor(Math.random() * letras.length)],
    numeros[Math.floor(Math.random() * numeros.length)],
    numeros[Math.floor(Math.random() * numeros.length)],
  ];
  return "IG" + partes.join("");
}

function extrairValor(mensagem) {
  // Normalizar a mensagem para facilitar a busca
  const mensagemNormalizada = mensagem.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Regex para capturar valores monetários em diferentes formatos
  // Captura números no formato "270,00", "270.00", "R$ 270,00", "270 reais", "$270", etc.
  const regex = /(?:r\$|\$)?\s*(?:no\s+valor\s+(?:de\s+))?([\d.,]+)(?:\s*(?:reais))?|(?:valor\s+(?:de\s+)?r\$?\s*([\d.,]+))/gi;

  // Palavras-chave que indicam um contexto monetário
  const palavrasChave = ["valor", "no valor de", "r$", "reais", "custa", "custou", "paguei", "pago"];

  // Encontrar todas as correspondências
  let matches = [];
  let match;
  while ((match = regex.exec(mensagemNormalizada)) !== null) {
    // Captura o valor do grupo 1 ou 2 (dependendo do formato)
    const valorCapturado = match[1] || match[2];
    if (valorCapturado) {
      matches.push({
        valor: valorCapturado,
        indice: match.index,
      });
    }
  }

  if (matches.length === 0) {
    console.log("⚠️ Nenhum valor monetário encontrado na mensagem:", mensagem);
    return null;
  }

  // Se houver mais de um valor, priorizar o que está mais próximo de uma palavra-chave monetária
  let valorSelecionado = null;
  let menorDistancia = Infinity;

  for (const match of matches) {
    let distanciaMinima = Infinity;
    for (const palavra of palavrasChave) {
      const posicaoPalavra = mensagemNormalizada.indexOf(palavra);
      if (posicaoPalavra !== -1) {
        const distancia = Math.abs(posicaoPalavra - match.indice);
        if (distancia < distanciaMinima) {
          distanciaMinima = distancia;
        }
      }
    }
    if (distanciaMinima < menorDistancia) {
      menorDistancia = distanciaMinima;
      valorSelecionado = match.valor;
    }
  }

  // Se não houver palavras-chave para priorizar, usar o último valor encontrado
  if (!valorSelecionado) {
    valorSelecionado = matches[matches.length - 1].valor;
  }

  // Converter o valor capturado para número
  let valorStr = valorSelecionado.replace(/\./g, '').replace(',', '.');
  let valor = parseFloat(valorStr);
  if (isNaN(valor)) {
    console.log("⚠️ Valor capturado não é um número válido:", valorSelecionado);
    return null;
  }

  console.log(`💰 Valor extraído: R$ ${valor.toFixed(2)} da mensagem: ${mensagem}`);
  return valor;
}

async function detectarNomeMembro(mensagemOriginal, igrejaId) { // <<< ADICIONADO igrejaId AQUI
  console.log(`🔍 Tentando detectar nome de membro na mensagem para Igreja ID: ${igrejaId}`);
  
  // Função interna para normalizar strings (remover acentos, minúsculas, trim)
  const normalizar = (str) => {
    if (!str || typeof str !== 'string') return ''; // Retorna string vazia se a entrada for inválida
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  }

  const mensagemNormalizada = normalizar(mensagemOriginal);
  if (!mensagemNormalizada) {
      console.warn("  -> Mensagem original normalizada resultou em string vazia. Impossível detectar nome.");
      return null;
  }

  try {
    // --- MODIFICAÇÃO FIRESTORE: Buscar membros na subcoleção da igreja correta ---
    const membrosSnapshot = await db.collection("igrejas").doc(igrejaId).collection("membros").get();
    console.log(`  -> Buscando em /igrejas/${igrejaId}/membros. Encontrados: ${membrosSnapshot.size} membros.`);

    // Itera sobre os documentos dos membros encontrados
    for (const doc of membrosSnapshot.docs) {
      const membroData = doc.data();
      const nomeSalvo = membroData.nome; // Pega o nome do membro do documento
      
      // Verifica se o nome existe e é uma string antes de normalizar
      if (nomeSalvo && typeof nomeSalvo === 'string') {
          const nomeNormalizado = normalizar(nomeSalvo);
          
          // Verifica se o nome normalizado não está vazio e se está contido na mensagem normalizada
          if (nomeNormalizado && mensagemNormalizada.includes(nomeNormalizado)) {
            console.log(`    -> Nome encontrado: '${nomeSalvo}' (ID: ${doc.id})`);
            // Retorna o ID do documento e o nome original
            return { id: doc.id, nome: nomeSalvo }; 
          }
      } else {
          console.warn(`  -> Membro com ID ${doc.id} na igreja ${igrejaId} não possui um nome válido.`);
      }
    }

    // Se o loop terminar sem encontrar nenhum nome
    console.log("  -> Nenhum nome de membro conhecido encontrado na mensagem.");
    return null;

  } catch (error) {
      console.error(`❌ Erro ao buscar membros para detecção de nome na igreja ${igrejaId}:`, error);
      // Retorna null em caso de erro para não interromper o fluxo principal
      return null; 
  }
}

async function atualizarCadastroMembro(membroId, dizimo, igrejaId) { // <<< ADICIONADO igrejaId AQUI
  console.log(`📋 Atualizando cadastro do membro ${membroId} na Igreja ID: ${igrejaId} com dízimo de R$ ${dizimo.toFixed(2)}`);
  // --- MODIFICAÇÃO FIRESTORE: Referência correta ao membro na subcoleção da igreja ---
  const membroRef = db.collection("igrejas").doc(igrejaId).collection("membros").doc(membroId);
  
  try {
    // Atualizar o status de dizimista
    await membroRef.update({
      dizimista: true,
    });
    console.log(`  -> Status dizimista atualizado para true.`);

    // Adicionar o dízimo à subcoleção "dizimos" do membro
    await membroRef.collection("dizimos").add({
      valor: dizimo,
      data: Timestamp.now(), // Usar Timestamp.now() para consistência
    });
    console.log(`  -> Registro de dízimo adicionado à subcoleção 'dizimos'.`);

  } catch (error) {
    console.error(`❌ Erro ao atualizar cadastro ou adicionar dízimo para membro ${membroId} na igreja ${igrejaId}:`, error);
    // Considerar se deve lançar o erro ou apenas logar
    // throw error; // Lançar o erro pode interromper o processamento de múltiplos dízimos
  }
}

async function cadastrarMembroWhatsApp(mensagem, telefone, igrejaId) { // <<< ADICIONADO igrejaId AQUI
  console.log("📝 Mensagem recebida para cadastro:", mensagem);
  console.log(`⛪ Para Igreja ID: ${igrejaId}`); // Log do igrejaId recebido

  let telefoneMembro = "0"; // Valor padrão se não houver telefone na mensagem
  let mensagemSemTelefone = mensagem; // Criar uma cópia da mensagem para remover o telefone após extração

  // Tentar extrair um número de telefone da mensagem
  const regexTelefone = /(?:telefone|celular|contato)?\s*(?:\+55)?\s*(\d{2}\s*\d{1}\s*\d{4}\s*-?\s*\d{4}|\d{2}\s*\d{8,9}|\d{10,11})/i;
  const matchTelefone = mensagem.match(regexTelefone);
  if (matchTelefone) {
    const numeroEncontrado = matchTelefone[1].replace(/[\s-]/g, "");
    telefoneMembro = normalizarTelefoneBrasil(numeroEncontrado);
    if (!telefoneMembro) {
      console.log("⚠️ Número de telefone extraído da mensagem é inválido. Definindo como 0.");
      telefoneMembro = "0";
    } else {
      console.log("📞 Telefone extraído da mensagem e normalizado:", telefoneMembro);
      mensagemSemTelefone = mensagem.replace(matchTelefone[0], "").trim();
    }
  } else {
    console.log("📞 Nenhum telefone encontrado na mensagem. Definindo como 0.");
  }

  let nome = "";
  let idade = 0;
  let funcao = [];
  let profissao = "";
  let estadoCivil = "";
  let dizimista = false;
  let batizado = false;
  let cursos = {
    encontroComDeus: false,
    cursoDeBatismo: false,
    maturidadeNoEspirito: false,
    escolaDeLideres: false,
    outros: [],
  };

  const mensagemNormalizada = mensagemSemTelefone
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  let partes = mensagemSemTelefone.split(",").map(parte => parte.trim());
  console.log("📋 Partes:", partes);

  if (partes[0]) {
    nome = partes[0].replace(/^(cadastro de|cadastro)\s+/i, "").trim();
    nome = nome
      .split(" ")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  console.log("📋 Nome:", nome);

  const funcoesFixas = [
    "membro", "membra", "lider", "pastor", "pastora", "diacono", "diaconisa",
    "missionario", "missionaria", "obreiro", "obreira", "midias sociais",
    "fotografo", "fotografa", "filmador", "filmadora", "louvor", "musico",
    "musicista", "levita", "equipe de musica", "cantina", "recepcionista",
    "iluminacao", "tecnico de som", "tecnica de som", "lider de jovens",
    "lider de mulheres", "lider de homens", "servicos sociais", "departamento kids",
    "intercessor", "intercessora", "evangelista", "professor de escola biblica",
    "professora de escola biblica", "auxiliar de escola biblica", "tesoureiro",
    "tesoureira", "secretario", "secretaria", "porteiro", "porteira", "zelador",
    "zeladora", "danca", "teatro", "coreografia", "equipe de eventos",
    "organizador de retiros", "organizadora de retiros", "aconselhador",
    "aconselhadora", "visitador", "visitadora", "capelao", "capela", "lider de pequeno grupo",
    "equipe de oracao", "equipe de limpeza", "equipe de manutencao",
    "equipe de comunicacao", "editor de videos", "editora de videos",
    "designer grafico", "designer grafica", "projecao", "sonoplasta",
    "interprete de libras", "equipe de casais", "equipe de saude",
    "discipulador", "discipuladora", "supervisor", "supervisora", "baterista", "guitarrista", 
    "tecladista", "baixista", "vocalista", "pianista", "violonista", "saxofonista", "trompetista", 
    "flautista", "violoncelista", "violinista", "percussionista", "acordeonista", "trombonista", 
    "clarinetista", "oboísta", "fagocista", "harpista", "sanfonista", "ukulelista", "bandolinista", 
    "cavaquinista", "berimbauista", "atabaquista", "pandeirista", "triadista", "zabumbista", "gaitista", 
    "sitarista", "koraísta", "balafonista", "didgeridooísta", "eremita", "lirista", "organista"
  ];

  const profissoesFixas = [
    "medico", "medica", "professor", "professora", "engenheiro", "engenheira",
    "autonomo", "autonoma", "vendedor", "vendedora", "estudante", "empresario",
    "empresaria", "designer", "advogado", "advogada", "contador", "contadora",
    "programador", "programadora", "gerente", "marketing", "arquiteto", "arquiteta",
    "psicologo", "psicologa", "fisioterapeuta", "dentista", "enfermeiro", "enfermeira",
    "farmaceutico", "farmaceutica", "jornalista", "publicitario", "publicitaria",
    "cozinheiro", "cozinheira", "eletricista", "mecanico", "mecanica", "motorista",
    "administrador", "administradora", "economista", "veterinario", "veterinaria",
    "fotografo", "fotografa", "artista", "pedreiro", "pedreira", "costureiro",
    "costureira", "barbeiro", "barbeira", "cabeleireiro", "cabeleireira", "manicure",
    "pedicure", "maquiador", "maquiadora", "nutricionista", "personal trainer", "ator",
    "atriz", "musico", "musicista", "escritor", "escritora", "editor", "editora",
    "tradutor", "tradutora", "interprete", "bibliotecario", "bibliotecaria",
    "historiador", "historiadora", "geografo", "geografa", "biologo", "biologa",
    "quimico", "quimica", "fisico", "fisica", "matematico", "matematica",
    "estatistico", "estatistica", "analista de dados", "cientista de dados",
    "desenvolvedor", "desenvolvedora", "analista de sistemas", "tecnico de ti",
    "tecnica de ti", "engenheiro de software", "engenheira de software",
    "arquiteto de software", "arquiteta de software", "consultor", "consultora",
    "auditor", "auditora", "financeiro", "bancario", "bancaria", "corretor de imoveis",
    "corretora de imoveis", "corretor de seguros", "corretora de seguros",
    "agente de viagens", "piloto", "comissario de bordo", "comissaria de bordo",
    "marinheiro", "marinheira", "policial", "bombeiro", "bombeira", "seguranca",
    "jardineiro", "jardineira", "paisagista", "agronomo", "agronoma", "zootecnista",
    "ambientalista", "sociologo", "sociologa", "antropologo", "antropologa",
    "assistente social", "terapeuta ocupacional", "fonoaudiologo", "fonoaudiologa",
    "oftalmologista", "dermatologista", "cardiologista", "neurologista", "ortopedista",
    "pediatra", "psiquiatra", "chef de cozinha", "garcom", "garconete", "recepcionista",
    "atendente", "operador de caixa", "operadora de caixa", "estoquista", "logistico",
    "marceneiro", "marceneira", "serralheiro", "serralheira", "pintor", "pintora"
  ];

  const cursosFixos = [
    "encontro com deus", "curso de batismo", "maturidade no espirito", "escola de lideres",
  ];

  let mensagemSemCursos = mensagemSemTelefone;
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    const parteNormalizada = parte
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    const cursoMatch = parteNormalizada.match(/(?:fez o curso|curso|fez)\s+([^,]+)/i);
    if (cursoMatch) {
      let cursoExtraido = cursoMatch[1].trim();
      cursoExtraido = cursoExtraido.replace(/^(de\s+)/, "").trim();
      
      if (parteNormalizada.includes("encontro com deus")) cursos.encontroComDeus = true;
      else if (parteNormalizada.includes("curso de batismo")) cursos.cursoDeBatismo = true;
      else if (parteNormalizada.includes("maturidade no espirito")) cursos.maturidadeNoEspirito = true;
      else if (parteNormalizada.includes("escola de lideres")) cursos.escolaDeLideres = true;
      else if (!cursosFixos.some(curso => cursoExtraido.includes(curso))) {
        const cursoFormatado = cursoExtraido
          .split(" e ")
          .map(c => c.trim())
          .map(c => c.split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" "))
          .join(" e ");
        if (!cursos.outros.includes(cursoFormatado)) {
          cursos.outros.push(cursoFormatado);
        }
      }
      mensagemSemCursos = mensagemSemCursos.replace(parte, "").trim();
    }
  }

  partes = mensagemSemCursos.split(",").map(parte => parte.trim()).filter(parte => parte.length > 0);
  console.log("📋 Partes após remover cursos:", partes);

  for (const parte of partes) {
    const parteNormalizada = parte
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    const palavras = parteNormalizada.split(/\s+/);

    if (parteNormalizada.includes(nome.toLowerCase()) && parte === partes[0]) {
      continue;
    }

    const idadeMatch = parteNormalizada.match(/(\d+)\s*anos/);
    if (idadeMatch) idade = parseInt(idadeMatch[1]);

    let funcoesEncontradas = [];
    for (let i = 0; i < palavras.length; i++) {
      for (let j = i + 1; j <= palavras.length; j++) {
        const trecho = palavras.slice(i, j).join(" ");
        if (funcoesFixas.includes(trecho)) {
          const funcaoFormatada = trecho
            .split(" ")
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
          if (!funcoesEncontradas.includes(funcaoFormatada)) {
            funcoesEncontradas.push(funcaoFormatada);
          }
        }
      }
    }

    if (parteNormalizada.includes("membro da igreja") && !funcoesEncontradas.includes("Membro")) {
      funcoesEncontradas.push("Membro");
    }
    if (parteNormalizada.includes("trabalha na cantina da igreja") && !funcoesEncontradas.includes("Cantina")) {
      funcoesEncontradas.push("Cantina");
    }
    if (parteNormalizada.includes("servicos sociais da igreja") && !funcoesEncontradas.includes("Servicos Sociais")) {
      funcoesEncontradas.push("Servicos Sociais");
    }
    if (parteNormalizada.includes("departamento kids") && !funcoesEncontradas.includes("Departamento Kids")) {
      funcoesEncontradas.push("Departamento Kids");
    }

    funcoesEncontradas.forEach(f => {
      if (!funcao.includes(f)) {
        funcao.push(f);
      }
    });

    let profissaoEncontrada = null;
    for (let i = 0; i < palavras.length; i++) {
      for (let j = i + 1; j <= palavras.length; j++) {
        const trecho = palavras.slice(i, j).join(" ");
        if (profissoesFixas.includes(trecho)) {
          profissaoEncontrada = trecho;
          break;
        }
      }
      if (profissaoEncontrada) break;
    }

    if (!profissaoEncontrada && (parteNormalizada.includes("profissao") || parteNormalizada.includes("trabalha como") || parteNormalizada.includes("profissional em"))) {
      const indiceContexto = palavras.findIndex(p => p.includes("profissao") || p.includes("trabalha") || p.includes("profissional"));
      let textoExtraido = palavras.slice(indiceContexto + 1).join(" ").trim();
      if (parteNormalizada.includes("profissional em")) {
        textoExtraido = textoExtraido.replace(/^em\s+/, "").trim();
      }

      profissaoEncontrada = profissoesFixas.find(p => textoExtraido.includes(p)) || textoExtraido;

      if (!profissoesFixas.includes(profissaoEncontrada)) {
        try {
          console.log(`🔍 Chamando GPT-3.5-Turbo para classificar: "${textoExtraido}"`);
          const prompt = `
            Você é um assistente que ajuda a classificar textos em dois campos: "função na igreja" ou "profissão". 
            Funções na igreja são papéis ou atividades desempenhados dentro de uma organização religiosa, como "pastor", "músico", "líder de jovens", "técnico de som", etc.
            Profissões são ocupações profissionais, como "médico", "professor", "autônomo", "designer", etc.
            
            Dado o texto: "${textoExtraido}"
            
            1. Classifique se é uma "função na igreja" ou "profissão".
            2. Retorne o texto formatado com cada palavra capitalizada (ex.: "técnico de som" -> "Técnico de Som").
            
            Responda no formato:
            {
              "tipo": "funcao" ou "profissao",
              "valor": "Texto Formatado"
            }
          `;

          const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 100,
            temperature: 0.3,
          });

          console.log("📡 Resposta do GPT-3.5-Turbo:", response.choices[0].message.content);
          const resultado = JSON.parse(response.choices[0].message.content);

          if (resultado.tipo === "funcao") {
            let funcaoExtraida = resultado.valor
              .split(" e ")
              .map(f => f.trim())
              .filter(f => f.length > 0);
            
            funcaoExtraida.forEach(f => {
              if (!funcao.includes(f)) {
                funcao.push(f);
              }
            });
          } else if (resultado.tipo === "profissao") {
            profissao = resultado.valor;
          }
        } catch (error) {
          console.error("⚠️ Erro ao chamar GPT-3.5-Turbo:", error.message);
          profissao = textoExtraido
            .split(" ")
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
          console.log(`🔄 Fallback manual para profissão: "${profissao}"`);
        }
      } else {
        profissao = profissaoEncontrada
          .split(" ")
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
      }
    } else if (profissaoEncontrada) {
      profissao = profissaoEncontrada
        .split(" ")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    }

    if (parteNormalizada.includes("casado") || parteNormalizada.includes("casada")) estadoCivil = "Casado";
    else if (parteNormalizada.includes("solteiro") || parteNormalizada.includes("solteira")) estadoCivil = "Solteiro";

    if (parteNormalizada.includes("dizimista")) dizimista = true;
    else if (parteNormalizada.includes("nao e dizimista")) dizimista = false;
    if (parteNormalizada.includes("batizado") || parteNormalizada.includes("batizada")) batizado = true;
  }

  funcao = funcao.length > 0 ? funcao.join(" e ") : "";
  cursos.outros = cursos.outros.length > 0 ? cursos.outros.join(" e ") : "";

  // --- MODIFICAÇÃO FIRESTORE ---
  // Salvar no Firestore na subcoleção correta da igreja
  // Gera um ID automático para o novo membro
  const membroRef = db.collection("igrejas").doc(igrejaId).collection("membros").doc(); 
  await membroRef.set({
    nome,
    telefone: telefoneMembro,
    idade,
    funcao,
    profissao,
    estadoCivil,
    dizimista,
    batizado,
    cursos,
    // Não precisa mais do igrejaId aqui, pois já está no caminho do documento
    dataCadastro: FieldValue.serverTimestamp(),
  });
  // --- FIM MODIFICAÇÃO FIRESTORE ---

  // Montar resposta
  return `
🙌 Membro cadastrado com sucesso!

📋 Nome: ${nome}
📱 Telefone: ${telefoneMembro === "0" ? "Não informado" : telefoneMembro}
🎂 Idade: ${idade > 0 ? idade : "Não informado"}
📌 Função: ${funcao || "Não informado"}
💼 Profissão: ${profissao || "Não informado"}
💍 Estado Civil: ${estadoCivil || "Não informado"}
💰 Dizimista: ${dizimista ? "✅ Sim" : "❌ Não"}
🕊️ Batizado: ${batizado ? "✅ Sim" : "❌ Não"}
🎓 Cursos:
  • Encontro com Deus: ${cursos.encontroComDeus ? "✅" : "❌"}
  • Curso de Batismo: ${cursos.cursoDeBatismo ? "✅" : "❌"}
  • Maturidade no Espírito: ${cursos.maturidadeNoEspirito ? "✅" : "❌"}
  • Escola de Líderes: ${cursos.escolaDeLideres ? "✅" : "❌"}
  • Outros: ${cursos.outros || "Nenhum"}

💾 Já está salvo no sistema!
`;
}

// SUGESTÃO DE ALTERAÇÃO PARA A FUNÇÃO registrarTransacaoFinanceira
// FOCO: Salvar categoriaPrincipal e subCategoria no Firestore.
// A lógica de retorno da mensagem para o WhatsApp será minimamente ajustada para incluir as novas categorias, se possível, ou mantida para evitar quebras.

async function registrarTransacaoFinanceira(mensagem, telefone, tipo, categoriaPrincipal, subCategoria, categoriaLegada, valor, nomeMembro, igrejaId, descricao) {
  // A assinatura da função foi alterada para receber categoriaPrincipal, subCategoria e categoriaLegada (que era a antiga "categoria")
  console.log(`🏦 Registrando transação para Igreja ID: ${igrejaId}`);
  console.log(`  -> Tipo: ${tipo}, Categoria Principal: ${categoriaPrincipal}, Subcategoria: ${subCategoria}, Categoria Legada: ${categoriaLegada}, Valor: ${valor}`);

  const dataAtual = new Date();
  const timestampAtual = FieldValue.serverTimestamp(); // Usar FieldValue para consistência

  // Normaliza o telefone antes de salvar (lógica original mantida)
  const telefoneNormalizado = normalizarTelefoneBrasil(telefone);

  // A função classificarMensagem já foi chamada antes, aqui recebemos os resultados.
  // Não precisamos mais chamar classificarMensagem aqui dentro.
  // const classificacao = classificarMensagem(mensagem); // REMOVIDO
  // console.log(`  -> Classificação interna (REMOVIDO): ${JSON.stringify(classificacao)}`);

  // --- PROCESSAMENTO DE TRANSAÇÃO SIMPLES (Lógica original mantida com ajustes para novas categorias) ---
  console.log("  -> Processando como transação simples.");
  const identificador = gerarIdentificador(); // Garanta que gerarIdentificador() exista

  const transacao = {
    identificador,
    descricao: descricao || mensagem, 
    valor: valor || 0, 
    tipo, // 'entrada' ou 'saida'
    
    // *** NOVOS CAMPOS DE CATEGORIA ***
    categoriaPrincipal: categoriaPrincipal || (tipo === "entrada" ? "Entradas" : "Despesas"), // Default se não vier
    subCategoria: subCategoria || (tipo === "entrada" ? "Entrada Diversa" : "Despesa Diversa"), // Default se não vier
    categoria: categoriaLegada || (tipo === "entrada" ? "Entrada Diversa" : "Despesa Diversa"), // Campo legado, pode ser a subCategoria ou um default
    // *******************************

    membro: nomeMembro?.nome || "Não informado", 
    membroId: nomeMembro?.id || null, 
    telefone: telefoneNormalizado, 
    data: timestampAtual, 
    pago: true, 
  };

  try {
    const transacaoRef = db.collection("igrejas").doc(igrejaId).collection("transacoes").doc(identificador);
    await transacaoRef.set(transacao);
    console.log(`    -> Transação ${identificador} salva em /igrejas/${igrejaId}/transacoes com categorias: P: ${transacao.categoriaPrincipal}, S: ${transacao.subCategoria}`);

    // --- NOVO BLOCO PARA REGISTRAR DÍZIMO INDIVIDUAL NO MEMBRO ---
    if (transacao.tipo === "entrada" && 
        (transacao.subCategoria === "Dízimo" || transacao.categoriaLegada === "Dízimo") && 
        transacao.membroId && 
        transacao.membroId !== "Não informado") {
      
      try {
        const dizimoMembroRef = db.collection("igrejas").doc(igrejaId)
                                  .collection("membros").doc(transacao.membroId)
                                  .collection("dizimos").doc(identificador); // Usar o mesmo ID da transação geral
        
        // Você pode querer salvar o mesmo objeto 'transacao' ou um objeto mais simples
        // Por exemplo, um objeto específico para o histórico de dízimos do membro:
        const dizimoParaMembro = {
          idTransacaoOriginal: identificador,
          valor: transacao.valor,
          data: transacao.data, // ou dataAtual se preferir a data do processamento
          descricao: transacao.descricao, // ou uma descrição mais específica para o dízimo
          registradoPor: telefoneNormalizado // Telefone de quem enviou o comando
        };

        await dizimoMembroRef.set(dizimoParaMembro);
        console.log(`    -> Dízimo individual ${identificador} também salvo para membro ${transacao.membroId} em sua subcoleção 'dizimos'.`);
      } catch (errorDizimoMembro) {
        console.error(`❌ Erro ao tentar salvar dízimo individual na subcoleção do membro ${transacao.membroId}:`, errorDizimoMembro);
        // Não lançar erro aqui para não impedir a resposta da transação principal,
        // mas é importante logar essa falha específica.
      }
    }
    // --- FIM DO NOVO BLOCO ---

    // Monta a resposta para o WhatsApp
    const tipoLabel = tipo === "entrada" ? "💸 Receita" : "📉 Despesa";
    const valorFormatado = (valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    const dataFormatada = dataAtual.toLocaleDateString("pt-BR");

    // Ajuste na mensagem de retorno para incluir as novas categorias de forma simples
    let categoriaExibida = transacao.subCategoria;
    if (transacao.categoriaPrincipal && transacao.categoriaPrincipal !== "Entradas" && transacao.categoriaPrincipal !== "Despesas") {
        // Para despesas, podemos mostrar Principal > Subcategoria se a principal for específica
        categoriaExibida = `${transacao.categoriaPrincipal} > ${transacao.subCategoria}`;
    } else if (tipo === "entrada" && transacao.subCategoria === "Dízimo" && nomeMembro?.nome && nomeMembro.nome !== "Não informado") {
        // Para dízimo, a descrição já costuma ter o nome, então a categoria pode ser só "Dízimo"
        categoriaExibida = "Dízimo";
    } else if (tipo === "entrada" && transacao.subCategoria === "Oferta") {
        categoriaExibida = "Oferta";
    }

    return `
${tipoLabel} registrada com sucesso!
👤 Membro: ${transacao.membro}
📋 Descrição: ${transacao.descricao}
💰 Valor: ${valorFormatado}
➡️ Tipo: ${tipo}
📂 Categoria: ${categoriaExibida} 
📅 Data: ${dataFormatada}
🗂️ Salvo no sistema!
    `;

  } catch (error) {
    console.error(`❌ Erro ao registrar transação simples ${identificador} para igreja ${igrejaId}:`, error);
    throw new Error("Falha ao salvar a transação no banco de dados."); 
  }
}

// Função para processar dízimos (COM BUSCA DE MEMBRO INTEGRADA)
async function processarDizimos(mensagem, igrejaId) {
  console.log(`[ProcessarDizimosDebug] Iniciando processamento de múltiplos dízimos para Igreja ID: ${igrejaId}`);
  console.log(`[ProcessarDizimosDebug] Mensagem recebida: "${mensagem}"`);

  const linhas = mensagem.split("\n");
  const dizimosParaRetorno = [];

  if (linhas.length === 0) {
    console.warn("[ProcessarDizimosDebug] Mensagem vazia ou sem linhas.");
    return dizimosParaRetorno; // Retorna array vazio se não houver linhas
  }

  const primeiraLinhaOriginal = linhas[0].trim();
  const primeiraLinhaNormalizada = primeiraLinhaOriginal.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  console.log(`[ProcessarDizimosDebug] Primeira linha original: "${primeiraLinhaOriginal}", Normalizada: "${primeiraLinhaNormalizada}"`);

  if (!(primeiraLinhaNormalizada.startsWith("dizimos") || primeiraLinhaNormalizada.startsWith("dizimo"))) {
    console.warn("[ProcessarDizimosDebug] ⚠️ Mensagem não iniciou com variações de 'Dízimos'. Nenhum dízimo múltiplo processado.");
    return dizimosParaRetorno; // Retorna array vazio se não for um comando de múltiplos dízimos
  }

  console.log(`[ProcessarDizimosDebug] Primeira linha reconhecida como início de múltiplos dízimos.`);

  // Regex para capturar: (Nome Completo) (Valor) (Modo de Pagamento)
  // Exemplo: "Fulano de Tal 123,45 Dinheiro"
  // Captura: 1: "Fulano de Tal", 2: "123,45", 3: "Dinheiro"
  const regexLinhaDizimo = /^(.*?)\s+([\d,.]+)\s+(.+)$/;

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i].trim();
    console.log(`[ProcessarDizimosDebug] Processando linha ${i}: "${linha}"`);

    if (!linha) {
      console.log(`[ProcessarDizimosDebug] Linha ${i} está vazia, pulando.`);
      continue;
    }

    const match = linha.match(regexLinhaDizimo);

    if (match) {
      let nomeExtraidoDaLinha = match[1].trim();
      let valorStr = match[2].replace(",", "."); // Substitui vírgula por ponto para parseFloat
      let modoPagamento = match[3].toLowerCase().trim();
      let valor = parseFloat(valorStr);

      console.log(`[ProcessarDizimosDebug] Dados extraídos da linha ${i}: Nome='${nomeExtraidoDaLinha}', ValorStr='${valorStr}', Modo='${modoPagamento}', ValorNum=${valor}`);

      if (isNaN(valor)) {
        console.warn(`[ProcessarDizimosDebug] Valor inválido na linha ${i}: "${valorStr}". Pulando esta linha.`);
        continue;
      }
      if (!nomeExtraidoDaLinha) {
        console.warn(`[ProcessarDizimosDebug] Nome não extraído na linha ${i}. Pulando esta linha.`);
        continue;
      }
      if (!modoPagamento) {
        console.warn(`[ProcessarDizimosDebug] Modo de pagamento não extraído na linha ${i}. Pulando esta linha.`);
        continue;
      }

      // Normalização adicional do modo de pagamento (exemplo)
      if (['cartao', 'c.c.', 'credito', 'débito'].includes(modoPagamento)) {
        modoPagamento = 'cartao';
      } else if (['dinheiro', 'cash'].includes(modoPagamento)) {
        modoPagamento = 'dinheiro';
      } // Adicionar mais normalizações conforme necessário

      let nomeFinalParaRegistro = nomeExtraidoDaLinha;
      let membroIdParaRegistro = nomeExtraidoDaLinha; // Padrão: usa nome extraído como ID
      let membroEncontradoInfo = "(Será criado/usado com nome da mensagem)";

      try {
        console.log(`[ProcessarDizimosDebug] Buscando membro existente para: '${nomeExtraidoDaLinha}' na igreja ${igrejaId}`);
        const membroDetectado = await detectarNomeMembro(nomeExtraidoDaLinha, igrejaId);

        if (membroDetectado && membroDetectado.id) {
          nomeFinalParaRegistro = membroDetectado.nome;
          membroIdParaRegistro = membroDetectado.id;
          membroEncontradoInfo = `(Encontrado no DB: '${nomeFinalParaRegistro}', ID: ${membroIdParaRegistro})`;
          console.log(`[ProcessarDizimosDebug] Membro encontrado no DB: '${nomeFinalParaRegistro}' (ID: ${membroIdParaRegistro}). Usando este para o registro.`);
        } else {
          console.log(`[ProcessarDizimosDebug] Membro '${nomeExtraidoDaLinha}' não encontrado no DB. Será criado/usado com o nome extraído como ID.`);
        }

        const membroRef = db.collection("igrejas").doc(igrejaId).collection("membros").doc(membroIdParaRegistro);
        await membroRef.set(
          {
            nome: nomeFinalParaRegistro,
            ultimaAtualizacao: FieldValue.serverTimestamp(),
            dizimista: true
          },
          { merge: true }
        );
        console.log(`[ProcessarDizimosDebug] Membro '${nomeFinalParaRegistro}' (ID: ${membroIdParaRegistro}) atualizado/criado em /igrejas/${igrejaId}/membros`);

        const dizimoDocRef = membroRef.collection("dizimos").doc();
        await dizimoDocRef.set({
          valor,
          modoPagamento,
          data: FieldValue.serverTimestamp(),
          categoria: "Dízimo",
          pago: true,
        });
        console.log(`[ProcessarDizimosDebug] Dízimo de R$${valor} adicionado para '${nomeFinalParaRegistro}' em /igrejas/${igrejaId}/membros/${membroIdParaRegistro}/dizimos`);

        const transacaoRef = db.collection("igrejas").doc(igrejaId).collection("transacoes").doc();
        await transacaoRef.set({
          categoria: "Dízimo",
          data: FieldValue.serverTimestamp(),
          descricao: `Dízimo: ${nomeFinalParaRegistro} ${valor.toFixed(2).replace(".", ",")} ${modoPagamento}`,
          identificador: transacaoRef.id,
          // Ajuste aqui: Salvar o nome do membro no campo esperado pelo dashboard
          membroNome: nomeFinalParaRegistro, 
          // Manter o campo membroId, pois ele é útil para referenciar o documento do membro
          membroId: membroIdParaRegistro, 
          // Adicionar o campo formaPagamento esperado pelo dashboard
          formaPagamento: modoPagamento, 
          pago: true,
          tipo: "entrada",
          valor,
        });
        console.log(`[ProcessarDizimosDebug] Transação de Dízimo adicionada para '${nomeFinalParaRegistro}' em /igrejas/${igrejaId}/transacoes com membroNome e formaPagamento corretos`);
        
        dizimosParaRetorno.push({
          nomeMembro: nomeFinalParaRegistro,
          valor: valor,
          modoPagamento: modoPagamento
        });

      } catch (error) {
          console.error(`[ProcessarDizimosDebug] ❌ Erro ao processar dízimo para '${nomeExtraidoDaLinha}' ${membroEncontradoInfo} na igreja ${igrejaId}:`, error);
      }
    } else {
      console.warn(`[ProcessarDizimosDebug] Linha ignorada (formato inválido): ${linha}`);
    }
  }

  console.log(`[ProcessarDizimosDebug] ✅ ${dizimosParaRetorno.length} dízimos múltiplos efetivamente processados e preparados para retorno para Igreja ID: ${igrejaId}`);
  return dizimosParaRetorno;
}
  
// ========================================================================
// FUNÇÕES AUXILIARES (DEFINIÇÕES ADICIONADAS AQUI)
// ========================================================================

// Função auxiliar para extrair dados da requisição (CORRIGIDA PARA req.body.text.message)
function extractMessageAndPhone(req) {
  console.log("🔍 Corpo da requisição recebida (req.body):", JSON.stringify(req.body, null, 2));

  let mensagem = null;
  let telefone = null;
  let audioData = null; 
  let urlAudio = null;
  let imagemData = null; 
  let urlImagem = null;
  let fromMe = false;
  let connectedPhoneRaw = null; 

  if (req.body) {
    // ** CORREÇÃO: Acessar req.body.text.message para pegar a string **
    if (req.body.text && typeof req.body.text.message === 'string') {
      mensagem = req.body.text.message;
    } else {
      // Fallback para outras possíveis estruturas (menos provável agora)
      mensagem = req.body.message || req.body.body || null;
    }
    console.log(`Valor extraído para mensagem: ${mensagem}`); // Log atualizado

    telefone = req.body.phone || req.body.sender || req.body.from || null;
    fromMe = req.body.fromMe === true;
    connectedPhoneRaw = req.body.connectedPhone || req.body.instanceId || null;

    // Mídia (lógica mantida)
    let mediaInfo = req.body.media || (req.body.message && req.body.message.media) || null;
    if (!mediaInfo && (req.body.type === "image" || req.body.type === "audio")) {
        mediaInfo = req.body; 
    }
    if (mediaInfo) {
      const mediaType = mediaInfo.type || mediaInfo.mimetype;
      const mediaUrl = mediaInfo.url || mediaInfo.downloadUrl || mediaInfo.body;
      if (mediaType?.includes("audio")) {
        urlAudio = mediaUrl;
        console.log(`Extraído URL de Áudio: ${urlAudio}`);
        if (!mensagem) mensagem = `[Áudio recebido: ${urlAudio}]`; 
      } else if (mediaType?.includes("image")) {
        urlImagem = mediaUrl;
        console.log(`Extraído URL de Imagem: ${urlImagem}`);
        if (!mensagem) mensagem = `[Imagem recebida: ${urlImagem}]`;
      }
    }

    // Normalização do telefone do REMETENTE usando a função completa
if (telefone) {
  let telOriginal = telefone; // Guardar o original para o log, se quiser
  telefone = normalizarTelefoneBrasil(telOriginal); // Chama a função importada!
  console.log(`Telefone remetente normalizado (usando normalizarTelefoneBrasil) de ${telOriginal} para ${telefone}`);
} else {
    console.warn("Telefone do remetente não encontrado no payload!"); // ESTE ELSE PERMANECE
}

    if (!connectedPhoneRaw) {
        console.warn("Telefone conectado (connectedPhone/instanceId) não encontrado no payload!");
    }
  }

  console.log("Dados extraídos por extractMessageAndPhone ->", {
    mensagem,
    telefone,
    urlAudio,
    urlImagem,
    fromMe,
    connectedPhoneRaw
  });

  return {
    mensagem, // Agora deve ser a string correta
    telefone, 
    audioData,
    urlAudio,
    imagemData,
    urlImagem,
    fromMe,
    connectedPhoneRaw 
  };
}

// SUGESTÃO DE ALTERAÇÃO PARA A FUNÇÃO classificarMensagem
// FOCO: Aprimorar a categorização de DESPESAS.
// As demais lógicas (Dízimos Múltiplos, Relatório, Cadastro, Entradas) permanecem como no original.

// ========================================================================
// MAPA DE CATEGORIAS DE DESPESAS (Baseado em categorias_despesas.md)
// ========================================================================
const mapaCategoriasDespesas = {
  "Despesas Operacionais e Administrativas": {
    "Aluguel do Templo/Salão": ["aluguel do templo", "aluguel do salao", "aluguel igreja"],
    "Contas de Consumo - Água": ["conta de agua", "agua"],
    "Contas de Consumo - Luz": ["conta de luz", "luz", "energia eletrica", "energia"],
    "Contas de Consumo - Gás": ["conta de gas", "gas", "botijao de gas"],
    "Contas de Consumo - Internet": ["conta de internet", "internet", "provedor de internet"],
    "Contas de Consumo - Telefone": ["conta de telefone", "telefone fixo", "telefone movel", "celular da igreja"],
    "Materiais de Escritório e Papelaria": ["material de escritorio", "papelaria", "caneta", "papel", "toner", "cartucho"],
    "Software e Assinaturas": ["software", "assinatura de sistema", "sistema de gestao", "contabilidade online", "streaming"],
    "Serviços de Contabilidade e Advocacia": ["contador", "contabilidade", "advogado", "serviços juridicos", "honorarios"],
    "Seguros": ["seguro predial", "seguro da igreja", "seguro responsabilidade"],
    "Manutenção e Reparos Prediais": ["manutencao predial", "reparo eletrico", "reparo hidraulico", "pintura igreja", "reforma igreja"],
    "Limpeza e Conservação": ["material de limpeza", "produtos de limpeza", "faxina", "limpeza terceirizada"],
    "Segurança": ["seguranca", "alarme", "monitoramento", "vigilancia"],
    "Transporte e Deslocamento": ["combustivel", "passagem", "manutencao veiculo", "transporte pastoral"],
    "Taxas e Impostos": ["iptu", "taxa municipal", "imposto"],
  },
  "Despesas com Pessoal e Liderança": {
    "Salário Pastoral (Prebenda, Côngrua)": ["salario pastoral", "prebenda", "congrua", "pagamento pastor"],
    "Ajudas de Custo para Pastores e Líderes": ["ajuda de custo pastor", "auxilio moradia pastor", "auxilio alimentacao pastor"],
    "Salários de Funcionários": ["salario funcionario", "pagamento secretaria", "pagamento limpeza", "pagamento tecnico de som"],
    "Encargos Sociais e Trabalhistas": ["inss", "fgts", "decimo terceiro", "ferias funcionario"],
    "Benefícios": ["plano de saude funcionario", "vale alimentacao", "vale transporte funcionario"],
    "Treinamento e Desenvolvimento de Líderes e Voluntários": ["treinamento de lideres", "curso para voluntarios", "capacitacao ministerial"],
    "Despesas com Viagens Missionárias e Ministeriais de Líderes": ["viagem missionaria", "viagem ministerial", "passagem lider"],
  },
  "Despesas com Ministérios e Departamentos": {
    "Departamento Infantil (Kids)": ["material kids", "lanche criancas", "ebd infantil", "departamento infantil"],
    "Departamento de Jovens e Adolescentes": ["evento de jovens", "acampamento de jovens", "material jovens", "departamento de jovens"],
    "Departamento de Casais": ["encontro de casais", "curso para casais", "ministerio de casais"],
    "Ministério de Louvor e Adoração": ["instrumento musical", "equipamento de som", "cabo", "palheta", "cordas", "uniforme louvor", "microfone", "sonoplastia"],
    "Ministério de Ensino (Escola Bíblica Dominical, cursos)": ["material ebd", "livro ebd", "apostila curso", "escola biblica"],
    "Ministério de Ação Social e Evangelismo": ["doacao cesta basica", "evento evangelistico", "material de evangelismo", "acao social"],
    "Ministério de Comunicação": ["equipamento de filmagem", "software de edicao video", "transmissao online culto", "design grafico igreja", "comunicacao"],
    "Outros Ministérios": ["ministerio de mulheres", "ministerio de homens", "encontro de homens", "encontro de mulheres"],
  },
  "Despesas com Eventos e Celebrações": {
    "Eventos Especiais (conferências, seminários, congressos)": ["conferencia", "seminario", "congresso", "evento especial", "preletor convidado", "musico convidado"],
    "Celebrações (Páscoa, Natal, Aniversário da Igreja)": ["decoracao de pascoa", "decoracao de natal", "aniversario da igreja", "cantata de natal"],
    "Batismos e Ceias": ["material batismo", "tunica batismo", "pao e suco ceia", "santa ceia"],
  },
  "Despesas Financeiras e Bancárias": {
    "Tarifas bancárias": ["tarifa bancaria", "manutencao de conta", "ted", "doc", "taxa boleto"],
    "Juros e multas": ["juros boleto", "multa atraso"],
    "Taxas de máquinas de cartão": ["taxa maquininha", "taxa cartao"],
  },
  "Outras Despesas": {
    "Aquisição de Imobilizado": ["compra de movel", "compra de equipamento", "compra de veiculo", "imobilizado"],
    "Despesas com Hospitalidade": ["recepcao de convidados", "cafe para visitantes", "hospitalidade"],
    "Flores e Decoração do Templo": ["flores igreja", "decoracao templo", "arranjo floral"],
    "Contribuições para Convenções ou Associações Denominacionais": ["contribuicao convencao", "taxa associacao"],
    "Projetos Missionários": ["oferta missionaria", "sustento missionario", "projeto missoes"],
    "Fundo de Reserva ou Contingência": ["fundo de reserva", "contingencia"],
  }
};

// Função auxiliar para encontrar categoria de despesa (será usada dentro de classificarMensagem)
function encontrarCategoriaDespesaDetalhada(mensagem) {
  const msgLower = mensagem.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // Normaliza e remove acentos
  for (const catPrincipal in mapaCategoriasDespesas) {
    for (const subCat in mapaCategoriasDespesas[catPrincipal]) {
      const palavrasChave = mapaCategoriasDespesas[catPrincipal][subCat];
      if (palavrasChave.some(palavra => msgLower.includes(palavra.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")))) {
        return { categoriaPrincipal: catPrincipal, subCategoria: subCat };
      }
    }
  }
  return { categoriaPrincipal: "Despesas", subCategoria: "Despesa Diversa" }; // Default se nenhuma específica for encontrada
}


// ========================================================================
// FUNÇÃO DE CLASSIFICAÇÃO (PRÉ-FILTRO - SUGESTÃO DE AJUSTE)
// ========================================================================
function classificarMensagemComLogs(mensagem) { // Forçando o redeploy
  if (!mensagem || typeof mensagem !== 'string') {
    console.log("classificarMensagem: Mensagem inválida ou não é string.");
    return { tipo: "outro" };
  }

  const msgLower = mensagem.toLowerCase().trim();
  const msgOriginal = mensagem.trim(); // Manter original para extração

  // --- PRIORIDADE 1: Verificação de Dízimos Múltiplos (COM LOGS DETALHADOS PARA DEPURAÇÃO) ---
  const linhasDaMensagem = msgOriginal.split('\n');
  const primeiraLinhaOriginal = linhasDaMensagem[0].trim();
  let primeiraLinhaParaVerificacao = primeiraLinhaOriginal.toLowerCase();

  console.log(`[MultiDizimosDebug] Mensagem Original Recebida: "${msgOriginal}"`);
  console.log(`[MultiDizimosDebug] Linhas Detectadas (após split '\n'): ${JSON.stringify(linhasDaMensagem)}`);
  console.log(`[MultiDizimosDebug] Primeira Linha (original trim): "${primeiraLinhaOriginal}"`);

  if (primeiraLinhaParaVerificacao.endsWith(":")) {
    primeiraLinhaParaVerificacao = primeiraLinhaParaVerificacao.slice(0, -1).trim();
  }
  console.log(`[MultiDizimosDebug] Primeira Linha (para verificação, lowercased, sem ':' final): "${primeiraLinhaParaVerificacao}"`);

  const palavrasChaveMultiplosDizimos = ["dízimos", "dizimos", "dízimo", "dizimo"];
  const isPalavraChaveMultiplos = palavrasChaveMultiplosDizimos.includes(primeiraLinhaParaVerificacao);
  console.log(`[MultiDizimosDebug] Primeira linha é palavra-chave de múltiplos dízimos? ${isPalavraChaveMultiplos}`);

  if (isPalavraChaveMultiplos) {
    const temLinhasDeDadosValidas = linhasDaMensagem.length > 1 && linhasDaMensagem.slice(1).some(linha => linha.trim() !== '');
    console.log(`[MultiDizimosDebug] Existem linhas de dados subsequentes válidas? ${temLinhasDeDadosValidas}`);
    
    if (temLinhasDeDadosValidas) {
      console.log(`classificarMensagem: Detectado padrão de MÚLTIPLOS DÍZIMOS. Linha verificada: "${primeiraLinhaParaVerificacao}". Múltiplas linhas de dados detectadas.`);
      return { tipo: "financeiro", subTipo: "multiplos_dizimos" };
    } else {
      console.log(`[MultiDizimosDebug] Palavra-chave de múltiplos dízimos detectada, mas as linhas de dados subsequentes não são válidas ou estão ausentes.`);
      // Neste ponto, a função continuará para as próximas verificações (relatório, financeiro único, etc.)
      // o que pode explicar o comportamento de processar como dízimo único se a primeira linha de dados se encaixar nesse padrão.
    }
  }
  // --- Fim da Verificação de Dízimos Múltiplos ---

  // --- Verificação de Relatório ---
  const palavrasRelatorio = ["relatório", "relatorio", "balanço", "resumo financeiro", "extrato"];
  if (palavrasRelatorio.some(palavra => msgLower.includes(palavra))) {
    let periodo = "mes_atual";
    if (msgLower.includes("semana") || msgLower.includes("semanal")) periodo = "semana_atual";
    if (msgLower.includes("hoje") || msgLower.includes("dia")) periodo = "hoje";
    if (msgLower.includes("ultimos 7 dias")) periodo = "ultimos_7_dias";
    if (msgLower.includes("ultimos 15 dias")) periodo = "ultimos_15_dias";
    if (msgLower.includes("ultimos 30 dias")) periodo = "ultimos_30_dias";
    if (msgLower.includes("ano atual")) periodo = "ano_atual";
    console.log(`classificarMensagem: Detectado padrão de RELATÓRIO (${periodo}).`);
    return { tipo: "relatorio", periodo: periodo };
  }

  // --- Verificação Financeira ÚNICA ---
const palavrasEntrada = ["oferta", "entrada", "doação", "doacao", "contribuição", "contribuicao", "recebido", "recebi", "campanha"];
const palavrasSaida = ["saida", "saída", "despesa", "pagamento", "paguei", "compra", "conta"];
const palavrasDizimoUnico = ["dízimo", "dizimo"]; // Renomeado para evitar confusão com a lista de múltiplos

const regexValorSimples = /([0-9]+(?:[.,][0-9]{1,2})?)/;
const matchValor = msgOriginal.match(regexValorSimples);
const valorExtraido = matchValor ? parseFloat((matchValor[1] || "0").replace(",", ".")) : null;

let tipoTransacao = null;
let categoriaPrincipalRetorno = null;
let subCategoriaRetorno = null;
let categoriaLegadaRetorno = "Diversos";

if (palavrasEntrada.some(palavra => msgLower.includes(palavra))) {
  tipoTransacao = "entrada";

  // As verificações específicas devem vir primeiro, da mais específica para a mais genérica
  if (msgLower.includes("dízimo") || msgLower.includes("dizimo")) {
    categoriaPrincipalRetorno = "Entradas";
    subCategoriaRetorno = "Dízimo";
    categoriaLegadaRetorno = "Dízimo";
  } else if (msgLower.includes("oferta")) {
    categoriaPrincipalRetorno = "Entradas";
    subCategoriaRetorno = "Oferta";
    categoriaLegadaRetorno = "Oferta";
  } else if (msgLower.includes("campanha")) {
    categoriaPrincipalRetorno = "Entradas";
    subCategoriaRetorno = "Campanha";
    categoriaLegadaRetorno = "Campanha";
  } else if (msgLower.includes("doação") || msgLower.includes("doacao")) {
    categoriaPrincipalRetorno = "Entradas";
    subCategoriaRetorno = "Doação";
    categoriaLegadaRetorno = "Doação";
  } else {
    categoriaPrincipalRetorno = "Entradas";
    subCategoriaRetorno = "Entrada Diversa";
    categoriaLegadaRetorno = "Entrada Diversa";
  }

} else if (palavrasSaida.some(palavra => msgLower.includes(palavra))) {
  tipoTransacao = "saida";

  const despesaCategorizada = encontrarCategoriaDespesaDetalhada(msgOriginal);
  categoriaPrincipalRetorno = despesaCategorizada.categoriaPrincipal;
  subCategoriaRetorno = despesaCategorizada.subCategoria;
  categoriaLegadaRetorno = despesaCategorizada.subCategoria;

} else if (msgLower.includes("dízimo") || msgLower.includes("dizimo")) {
  tipoTransacao = "entrada";
  categoriaPrincipalRetorno = "Entradas";
  subCategoriaRetorno = "Dízimo";
  categoriaLegadaRetorno = "Dízimo";
}

if (tipoTransacao && valorExtraido !== null) {
  console.log(`classificarMensagem: Detectado padrão FINANCEIRO ÚNICO. Tipo: ${tipoTransacao}, Categoria Principal: ${categoriaPrincipalRetorno}, Subcategoria: ${subCategoriaRetorno}, Valor: ${valorExtraido}.`);
  return {
    tipo: "financeiro",
    detalhes: {
      tipo: tipoTransacao,
      categoriaPrincipal: categoriaPrincipalRetorno,
      subCategoria: subCategoriaRetorno,
      categoria: categoriaLegadaRetorno,
      valor: valorExtraido
    }
  };
}

  // --- Verificação de Cadastro ---
  const palavrasCadastro = ["cadastro", "cadastrar", "novo membro", "ficha", "inscrição"];
  const ehCadastroExplicito = palavrasCadastro.some(palavra => msgLower.includes(palavra));
  const temMultiplasVirgulas = (msgOriginal.match(/,/g) || []).length >= 3;
  const palavrasComunsCadastro = ["anos", "telefone", "casado", "casada", "solteiro", "solteira", "bairro", "rua", "numero", "profissão", "empresário", "curso", "dizimista", "batizado"];
  const temPalavrasComuns = palavrasComunsCadastro.some(palavra => msgLower.includes(palavra));
  const ehCadastroImplicito = temMultiplasVirgulas && temPalavrasComuns;

  if (ehCadastroExplicito || ehCadastroImplicito) {
    console.log(`classificarMensagem: Detectado padrão de CADASTRO (${ehCadastroExplicito ? 'explícito' : 'implícito'}).`);
    return { tipo: "cadastro" };
  }

  console.log("classificarMensagem: Nenhum padrão conhecido identificado. Classificando como 'outro'.");
  return { tipo: "outro" };
}

// Nota: A função encontrarCategoriaDespesaDetalhada(msgOriginal) não foi fornecida no trecho original,
// então ela é mantida como uma chamada a uma função que deve existir em outro lugar no seu código.
// Se ela não existir, a parte de categorização de despesas falhará.

// ========================================================================
// FUNÇÃO PRINCIPAL DO WEBHOOK (CÓDIGO FORNECIDO PELO USUÁRIO)
// ========================================================================

async function receberMensagemWhatsApp(req, res) {
  try {
    console.log("🚀 Função receberMensagemWhatsApp foi chamada!");

    // Validação inicial do corpo da requisição
    if (!req.body || typeof req.body !== "object") {
      console.error("❌ req.body inválido:", req.body);
      return res.status(400).send({ error: "Corpo da requisição inválido" });
    }

    // Extrair mensagem, telefone, áudio e imagem usando a função auxiliar (AGORA DEFINIDA ACIMA)
    const extractedData = extractMessageAndPhone(req);
    let mensagem = extractedData.mensagem;
    let formattedTelefone = extractedData.telefone; // Telefone JÁ normalizado pela extractMessageAndPhone
    const audioData = extractedData.audioData; // Mantido para compatibilidade, mas não usado
    const urlAudio = extractedData.urlAudio;
    const imagemData = extractedData.imagemData; // Mantido para compatibilidade, mas não usado
    const urlImagem = extractedData.urlImagem;
    const fromMe = extractedData.fromMe;
    const connectedPhoneRaw = extractedData.connectedPhoneRaw; // Pega o ID bruto da instância/igreja

    // Adiciona mais logs para depuração (agora redundantes com o log final de extractMessageAndPhone, mas mantidos)
    console.log("🔍 Valores extraídos (após chamada):");
    console.log("Mensagem:", mensagem);
    console.log("Telefone (Remetente Normalizado):", formattedTelefone);
    console.log("URL Áudio:", urlAudio);
    console.log("URL Imagem:", urlImagem);
    console.log("fromMe:", fromMe);
    console.log("Connected Phone (Bruto):", connectedPhoneRaw);

    // --- INÍCIO: Bloco para Obter e Normalizar igrejaId (connectedPhone) ---
    // const connectedPhoneRaw = req.body.connectedPhone; // REMOVIDO - Já pego via extractedData
    console.log("DEBUG: Valor de connectedPhoneRaw recebido é:", connectedPhoneRaw);
    if (!connectedPhoneRaw) {
      console.error("❌ Erro crítico: connectedPhone (identificador da igreja) não encontrado na requisição!", req.body);
      // Enviar resposta de erro para o WhatsApp e para a requisição HTTP
      // Verifica se formattedTelefone (remetente) existe antes de tentar enviar a mensagem
      if (formattedTelefone) {
          // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
          await enviarMensagemWhatsApp(formattedTelefone, "❌ Ocorreu um erro interno (ID Igreja). Por favor, contate o suporte."); 
      }
      return res.status(400).send({ error: "Identificador da igreja (connectedPhone) não encontrado." });
    }
    
    // Normaliza o connectedPhone para usar como igrejaId (FUNÇÃO DEFINIDA ACIMA)
    const igrejaId = formattedTelefone;
    console.log("DEBUG: Resultado de normalizarTelefoneBrasil(connectedPhoneRaw) é:", igrejaId);
    if (!igrejaId) { // A normalização agora retorna null em caso de falha
        console.error(`❌ Erro crítico: Falha ao normalizar connectedPhone '${connectedPhoneRaw}' para igrejaId.`);
        // Verifica se formattedTelefone (remetente) existe antes de tentar enviar a mensagem
        if (formattedTelefone) {
            // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
            await enviarMensagemWhatsApp(formattedTelefone, "❌ Ocorreu um erro interno (ID Igreja Inválido). Por favor, contate o suporte."); 
        }
        return res.status(400).send({ error: "Falha ao normalizar identificador da igreja." });
    }
    // A verificação .startsWith("+55") é redundante se a normalização sempre retorna nesse formato ou null
    
    console.log(`✅ Processando requisição para Igreja ID: ${igrejaId}`);
    // --- FIM: Bloco para Obter e Normalizar igrejaId ---

    // Verificar se a mensagem é do próprio bot
    if (fromMe) {
      console.log("📩 Mensagem enviada pelo próprio bot. Ignorando.");
      return res.status(200).send({ message: "Mensagem enviada pelo próprio bot. Ignorada." });
    }

    // Validação do telefone do remetente (já deve estar normalizado)
    if (!formattedTelefone || typeof formattedTelefone !== "string" || formattedTelefone.trim() === "") {
      console.error("❌ Telefone do remetente inválido após extração:", formattedTelefone);
      // Não deveria acontecer se a extração/normalização funcionou
      return res.status(400).send({ error: "Telefone do remetente não fornecido ou inválido" });
    }

    // Validação inicial da mensagem, áudio ou imagem
    if (!mensagem && !urlAudio && !urlImagem) {
      console.log("❌ Nenhuma mensagem, áudio ou imagem encontrada na requisição.");
      // Se chegou aqui, a extração falhou em pegar qualquer conteúdo útil
      return res.status(400).send({ error: "Nenhuma mensagem, áudio ou imagem encontrada na requisição." });
    }

    // Processamento de áudio
    if (urlAudio && typeof urlAudio === "string" && urlAudio.startsWith("http")) {
      try {
        console.log("📥 Tentando baixar áudio de:", urlAudio);
        // !!! GARANTA QUE fetch ESTEJA DISPONÍVEL (node-fetch?) !!!
        const resposta = await fetch(urlAudio);
        if (!resposta.ok) {
          throw new Error(`Falha ao baixar o áudio: ${resposta.status} ${resposta.statusText}`);
        }
        const arrayBuffer = await resposta.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        console.log("🎙️ Áudio baixado, enviando para transcrição...");
         // !!! GARANTA QUE openai ESTEJA CONFIGURADO/IMPORTADO !!!
        const transcriptionResult = await openai.audio.transcriptions.create({
          // file: buffer, // Passar como File-like object
          file: new File([buffer], "audio.ogg", { type: "audio/ogg" }), // Tentar criar File object
          model: "whisper-1",
          response_format: "text",
        });
        
        // A API pode retornar um objeto, pegue o texto de dentro
        const transcription = typeof transcriptionResult === 'string' ? transcriptionResult : transcriptionResult.text;

        if (!transcription || transcription.trim().length === 0) {
            console.warn("⚠️ Transcrição de áudio resultou em texto vazio.");
            throw new Error("Transcrição de áudio vazia.");
        }

        mensagem = transcription; // Sobrescreve a mensagem original com a transcrição
        console.log("🎙️ Áudio transcrito com sucesso:", mensagem);
      } catch (error) {
        console.error("❌ Erro ao transcrever áudio:", error.message, error.stack);
        // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(
          formattedTelefone,
          "❌ Não consegui entender o áudio. Tente novamente com uma voz mais clara ou mais curta."
        );
        if (!sucesso) {
          console.error("❌ Falha ao enviar mensagem de erro de áudio via Z-API.");
          return res.status(500).send({ error: "Erro ao processar áudio e enviar mensagem de erro", details: error.message });
        }
        // Retorna 400 para indicar que a requisição do usuário não pôde ser processada
        return res.status(400).send({ error: "Erro ao processar áudio" }); 
      }
    }

    // Processamento de imagem (ex.: comprovante)
    if (urlImagem && typeof urlImagem === "string" && urlImagem.startsWith("http")) {
      try {
        console.log("🖼️ Processando imagem:", urlImagem);
         // !!! GARANTA QUE openai ESTEJA CONFIGURADO/IMPORTADO !!!
        const description = await openai.chat.completions.create({
          model: "gpt-4-vision-preview", // ou gpt-4o
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Descreva o conteúdo da imagem. Se for um comprovante de PIX ou transferência, extraia o VALOR, a DATA (se houver) e o NOME ou CPF/CNPJ do destinatário (se houver). Se for outro tipo de imagem, apenas descreva brevemente." },
                { type: "image_url", image_url: { url: urlImagem, detail: "low" } }, // detail: low pode ser mais rápido e barato
              ],
            },
          ],
        });

        const imageContent = description.choices[0]?.message?.content;
        if (!imageContent || imageContent.trim().length === 0) {
            console.warn("⚠️ Análise de imagem resultou em texto vazio.");
            throw new Error("Análise de imagem vazia.");
        }
        
        // Decide se usa a descrição da imagem como a mensagem principal
        // Pode ser útil concatenar ou apenas usar a descrição
        mensagem = imageContent; // Sobrescreve a mensagem original
        console.log("🖼️ Imagem processada com sucesso:", mensagem);
      } catch (error) {
        console.error("❌ Erro ao processar imagem:", error.message, error.stack);
         // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(
          formattedTelefone,
          "❌ Não consegui processar a imagem. Envie um texto ou uma imagem mais clara."
        );
        if (!sucesso) {
          console.error("❌ Falha ao enviar mensagem de erro de imagem via Z-API.");
          return res.status(500).send({ error: "Erro ao processar imagem e enviar mensagem de erro", details: error.message });
        }
         // Retorna 400 para indicar que a requisição do usuário não pôde ser processada
        return res.status(400).send({ error: "Erro ao processar imagem" });
      }
    }

    // Verificar se a mensagem é válida APÓS processamento de mídia
    if (!mensagem || typeof mensagem !== "string" || mensagem.trim().length === 0) {
      console.warn("⚠️ Mensagem final vazia ou inválida após processamento de mídia:", mensagem);
      // Enviar uma resposta padrão ou erro?
      // Poderia enviar a mensagem padrão aqui também.
      // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
       await enviarMensagemWhatsApp(formattedTelefone, "Não entendi sua mensagem ou a mídia enviada. Pode tentar de outra forma?");
      return res.status(400).send({ error: "Mensagem não fornecida ou inválida após processamento" });
    }

    console.log(`✅ Mensagem final válida ("${mensagem}"), prosseguindo para classificação...`);

    // Classificação com pré-filtro
    // !!! GARANTA QUE classificarMensagem ESTEJA DEFINIDA/IMPORTADA !!!
    const classificacao = classificarMensagemComLogs(mensagem);
    console.log("Resultado da Classificação:", JSON.stringify(classificacao, null, 2));

    // Adicionar lógica para cadastro de membros dentro de um try/catch
    if (classificacao.tipo === "cadastro") {
      console.log("📬 Entrou no bloco de CADASTRO");
      // console.log("📞 Telefone enviado para cadastrarMembroWhatsApp:", formattedTelefone);
      // console.log("📝 Mensagem enviada para cadastrarMembroWhatsApp:", mensagem);
      try {
        // !!! GARANTA QUE cadastrarMembroWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const respostaCadastro = await cadastrarMembroWhatsApp(mensagem, formattedTelefone, igrejaId); 
        console.log("📤 Enviando resposta de cadastro para o WhatsApp:", respostaCadastro);
         // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(formattedTelefone, respostaCadastro);
        if (!sucesso) {
          console.error("❌ Falha ao enviar mensagem de cadastro via Z-API.");
          // Não retorna erro 500 aqui, pois o cadastro pode ter funcionado, só o envio falhou
          return res.status(200).send({ warning: "Cadastro processado, mas falha ao enviar confirmação via Z-API" });
        }
        console.log("✅ Mensagem de cadastro enviada com sucesso para o WhatsApp!");
        return res.sendStatus(200);
      } catch (error) {
        console.error("❌ Erro ao processar cadastro:", error.message, error.stack);
         // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(
          formattedTelefone,
          "❌ Ocorreu um erro ao processar o cadastro. Tente novamente ou entre em contato com o suporte."
        );
        // Retorna 500 pois o processamento principal falhou
        return res.status(500).send({ error: "Erro ao processar cadastro", details: error.message });
      }
    }

    if (classificacao.tipo === "financeiro") {
      console.log("💸 Entrou no bloco de FINANCEIRO");
      try {
        let respostaFormatada = "";
    
        if (classificacao.subTipo === "multiplos_dizimos") {
          console.log("🧾 Processando múltiplos dízimos...");
          // !!! GARANTA QUE processarDizimos ESTEJA DEFINIDA/IMPORTADA E FUNCIONANDO CORRETAMENTE !!!
          // Esta função deve retornar um array de objetos, onde cada objeto tem: { nomeMembro: 'Nome', valor: 100.00, modoPagamento: 'pix' }
          const dizimos = await processarDizimos(mensagem, igrejaId);
          if (!dizimos || dizimos.length === 0) {
            respostaFormatada = "❌ Nenhum dízimo válido encontrado na mensagem. Verifique o formato: primeira linha 'Dízimos:', depois 'Nome Completo Valor Modo' por linha.";
          } else {
            let listaDizimosFormatada = "📋 Lista de dízimos:\n";
            let totalPix = 0;
            let totalCartao = 0;
            let totalDinheiro = 0;
            let valorTotalGeral = 0;
    
            for (const dizimo of dizimos) {
              const valor = parseFloat(dizimo.valor) || 0;
              const modoPagamentoNormalizado = dizimo.modoPagamento?.toLowerCase().trim() || "desconhecido";
              
              if (modoPagamentoNormalizado === "pix") totalPix += valor;
              else if (modoPagamentoNormalizado === "cartao" || modoPagamentoNormalizado === "cartão") totalCartao += valor;
              else if (modoPagamentoNormalizado === "dinheiro") totalDinheiro += valor;
              valorTotalGeral += valor;
    
              // Formato do item da lista conforme exemplo do usuário
              listaDizimosFormatada += `* ${dizimo.nomeMembro || "Membro não identificado"}: R$ ${valor.toFixed(2)} (${dizimo.modoPagamento || "Modo não informado"})\n`;
            }
    
            const dataAtual = new Date();
            // Montando a resposta conforme o exemplo do usuário
            respostaFormatada = `💸 Dízimos registrados com sucesso!\n` +
                                `${listaDizimosFormatada}\n` + // Adiciona uma linha em branco após a lista
                                `📊 Totais por Tipo de Transação:\n` +
                                (totalPix > 0 ? `📲 TOTAL PIX: R$ ${totalPix.toFixed(2)}\n` : "") +
                                (totalCartao > 0 ? `💳 TOTAL CARTÃO: R$ ${totalCartao.toFixed(2)}\n` : "") +
                                (totalDinheiro > 0 ? `💵 TOTAL DINHEIRO: R$ ${totalDinheiro.toFixed(2)}\n` : "") +
                                `📅 Data: ${dataAtual.toLocaleDateString("pt-BR")}\n` +
                                `💰 Valor Total: R$ ${valorTotalGeral.toFixed(2)}\n` +
                                `🗂️ Salvo no sistema e nos cadastros dos membros!`;
          }
        } else {
          console.log("💰 Processando transação financeira única...");
         // Extrai os detalhes da classificação, incluindo as novas categorias
         const { tipo, categoriaPrincipal, subCategoria, categoria: categoriaLegada, valor } = classificacao.detalhes || {}; 
         
         // Validação ajustada para as novas categorias
         if (!tipo || !categoriaPrincipal || !subCategoria || !categoriaLegada || valor === undefined || valor === null) {
             console.error("❌ Detalhes da classificação financeira (única) incompletos:", classificacao.detalhes);
             throw new Error("Não foi possível extrair tipo, categorias detalhadas ou valor da mensagem financeira.");
         }
         
         const nomeMembro = await detectarNomeMembro(mensagem, igrejaId);
         
         console.log(`DEBUG: Chamando registrarTransacaoFinanceira com igrejaId: ${igrejaId}`); // Log adicional para confirmar

         respostaFormatada = await registrarTransacaoFinanceira(
           mensagem,           // mensagemOriginal
           formattedTelefone,  // telefoneRemetente
           tipo,               // tipoTransacao
           categoriaPrincipal, // categoriaPrincipal (NOVO)
           subCategoria,       // subCategoria (NOVO)
           categoriaLegada,    // categoriaLegada (NOVO, era o antigo 'categoria')
           valor,              // valor
           nomeMembro,         // nomeMembroDetectado
           igrejaId            // igrejaId (AGORA NA POSIÇÃO CORRETA)
           // descricaoOpcional (pode ser adicionado se necessário, ou deixado como default null na função)
         );
       }
    
        console.log("📤 Enviando resposta financeira para o WhatsApp:", respostaFormatada);
         // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(formattedTelefone, respostaFormatada);
        if (!sucesso) {
          console.error("❌ Falha ao enviar mensagem financeira via Z-API.");
           return res.status(200).send({ warning: "Transação processada, mas falha ao enviar confirmação via Z-API" });
        }
        console.log("✅ Mensagem financeira enviada com sucesso para o WhatsApp!");
        return res.sendStatus(200);
      } catch (error) {
        console.error("❌ Erro no processamento financeiro:", error.message, error.stack);
         // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(
          formattedTelefone,
          "❌ Ocorreu um erro ao processar a transação financeira. Verifique os dados ou contate o suporte."
        );
        return res.status(500).send({ error: "Erro ao processar transação financeira", details: error.message });
      }
    }

    if (classificacao.tipo === "relatorio") {
      console.log("📊 Entrou no bloco de RELATÓRIO");
      try {
        let resposta;
        const periodo = classificacao.periodo; // Ex: 'hoje', 'semana', 'mes', 'personalizado'
        const datas = classificacao.datas; // Array com [dataInicio, dataFim] se personalizado

        if (!periodo) {
             throw new Error("Tipo de período do relatório não identificado na classificação.");
        }

        // !!! GARANTA QUE gerarRelatorio ESTEJA DEFINIDA/IMPORTADA !!!
        resposta = await gerarRelatorio(periodo, igrejaId, datas ? datas[0] : null, datas ? datas[1] : null);
        
        // Verifica se a resposta é válida antes de enviar
        if (!resposta || typeof resposta !== 'string' || resposta.trim().length === 0) {
            console.warn("⚠️ Função gerarRelatorio retornou resposta vazia ou inválida.");
            resposta = "❌ Não foi possível gerar o relatório solicitado. Verifique o período ou tente novamente.";
        }

        console.log("📤 Enviando resposta de relatório para o WhatsApp (primeiros 200 chars):", resposta.substring(0,200));
         // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(formattedTelefone, resposta);
        if (!sucesso) {
          console.error("❌ Falha ao enviar mensagem de relatório via Z-API.");
           return res.status(200).send({ warning: "Relatório gerado, mas falha ao enviar via Z-API" });
        }
        console.log("✅ Mensagem de relatório enviada com sucesso para o WhatsApp!");
        return res.sendStatus(200);
      } catch (error) {
        console.error("❌ Erro ao gerar relatório:", error.message, error.stack);
         // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(
          formattedTelefone,
          "❌ Ocorreu um erro ao gerar o relatório. Tente novamente ou entre em contato com o suporte."
        );
        return res.status(500).send({ error: "Erro ao gerar relatório", details: error.message });
      }
    }

    // Caso o pré-filtro não identifique, usar IA
    console.log("🤖 Pré-filtro não classificou. Enviando para IA...");
    try {
      // !!! GARANTA QUE openai ESTEJA CONFIGURADO/IMPORTADO !!!
      const respostaIA = await openai.chat.completions.create({
        model: "gpt-3.5-turbo", // Ou outro modelo disponível
        messages: [
          {
            role: "system",
            content: `Você é um assistente de igreja. Classifique a mensagem do usuário em uma das categorias: 'cadastro', 'financeiro', 'relatorio' ou 'outro'.
- 'cadastro': Dados pessoais de membros (nome, idade, etc.).
- 'financeiro': Dinheiro, valores, dízimo, ofertas, pagamentos, gastos.
- 'relatorio': Pedido de relatório financeiro.
- 'outro': Qualquer outra coisa.
Responda APENAS com a palavra da categoria em minúsculas.`
          },
          { role: "user", content: mensagem }
        ],
        temperature: 0.2, // Baixa temperatura para classificação
        max_tokens: 10
      });

      const tipoIA = respostaIA.choices[0]?.message?.content?.toLowerCase().trim();
      console.log("🤖 Classificação da IA:", tipoIA);

      // AGORA, TENTA REUTILIZAR A LÓGICA PRINCIPAL COM BASE NA CLASSIFICAÇÃO DA IA
      if (tipoIA === "cadastro") {
        console.log("📬 IA classificou como CADASTRO. Reutilizando bloco...");
        // Copia a lógica do bloco if (classificacao.tipo === "cadastro") aqui
        // (É importante garantir que as funções chamadas aqui também estejam disponíveis)
        try {
          const respostaCadastro = await cadastrarMembroWhatsApp(mensagem, formattedTelefone, igrejaId);
          const sucesso = await enviarMensagemWhatsApp(formattedTelefone, respostaCadastro);
          if (!sucesso) return res.status(200).send({ warning: "Cadastro (via IA) processado, mas falha ao enviar confirmação" });
          return res.sendStatus(200);
        } catch (error) {
          console.error("❌ Erro ao processar cadastro (via IA):", error.message, error.stack);
          await enviarMensagemWhatsApp(formattedTelefone, "❌ Ocorreu um erro ao processar o cadastro (via IA). Tente novamente.");
          return res.status(500).send({ error: "Erro ao processar cadastro (via IA)", details: error.message });
        }
      } else if (tipoIA === "financeiro") {
        console.log("💸 IA classificou como FINANCEIRO. Reutilizando bloco (simplificado)...");
        // Idealmente, a IA deveria extrair mais detalhes, mas vamos tentar registrar como genérico
        // Ou chamar uma função específica para processamento pós-IA
        try {
          // Tenta registrar como uma transação genérica ou pede mais detalhes
          // Aqui, vamos apenas enviar uma mensagem indicando que precisa de mais detalhes ou formato específico
           const respostaFinIA = "Entendi que sua mensagem é sobre finanças, mas não consegui processá-la automaticamente. Para dízimos, use 'Dízimos:' na primeira linha. Para outras transações, tente 'Entrada/Saída [Descrição] [Valor]'.";
          // const nomeMembro = await detectarNomeMembro(mensagem, igrejaId);
          // const respostaFinIA = await registrarTransacaoFinanceira(mensagem, formattedTelefone, '?', '?', 0, nomeMembro, igrejaId); // Exemplo de chamada genérica
          const sucesso = await enviarMensagemWhatsApp(formattedTelefone, respostaFinIA);
          if (!sucesso) return res.status(200).send({ warning: "Financeiro (via IA) identificado, mas falha ao enviar resposta" });
          return res.sendStatus(200);
        } catch (error) {
          console.error("❌ Erro ao processar financeiro (via IA):", error.message, error.stack);
          await enviarMensagemWhatsApp(formattedTelefone, "❌ Ocorreu um erro ao processar a transação financeira (via IA).");
          return res.status(500).send({ error: "Erro ao processar financeiro (via IA)", details: error.message });
        }
      } else if (tipoIA === "relatorio") {
        console.log("📊 IA classificou como RELATÓRIO. Reutilizando bloco...");
        // Tenta gerar um relatório padrão (ex: mês atual) ou pede período
        try {
          // Vamos pedir para especificar o período
          const respostaRelIA = "Entendi que você quer um relatório. Por favor, especifique o período (ex: 'relatório da semana', 'relatório do mês', 'relatório personalizado DD/MM/AAAA DD/MM/AAAA').";
          // const respostaRelIA = await gerarRelatorio('mes', igrejaId); // Tenta gerar do mês atual
          const sucesso = await enviarMensagemWhatsApp(formattedTelefone, respostaRelIA);
          if (!sucesso) return res.status(200).send({ warning: "Relatório (via IA) identificado, mas falha ao enviar resposta" });
          return res.sendStatus(200);
        } catch (error) {
          console.error("❌ Erro ao gerar relatório (via IA):", error.message, error.stack);
          await enviarMensagemWhatsApp(formattedTelefone, "❌ Ocorreu um erro ao gerar o relatório (via IA).");
          return res.status(500).send({ error: "Erro ao gerar relatório (via IA)", details: error.message });
        }
      } else {
        // tipoIA === 'outro' ou classificação falhou
        console.log("❓ IA classificou como 'outro' ou falhou. Enviando resposta padrão.");
        const mensagemPadrao = "Olá! Sou o assistente da igreja. Posso ajudar com cadastros de membros, registro de dízimos/transações financeiras e geração de relatórios. Como posso te ajudar hoje?";
        
        // !!! ADICIONE O LOG AQUI !!!
        console.log(`>>> VALOR DA MENSAGEM ANTES DE ENVIAR: ${mensagemPadrao}`);
      
        // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        const sucesso = await enviarMensagemWhatsApp(
          formattedTelefone,
          mensagemPadrao
        );
        if (!sucesso) {
          console.error("❌ Falha ao enviar mensagem padrão (pós-IA) via Z-API.");
          return res.status(500).send({ error: "Erro ao enviar mensagem padrão via Z-API", details: "Falha no Z-API" });
        }
        return res.sendStatus(200);
      }
      
    } catch (iaError) {
        console.error("❌ Erro durante a classificação ou tratamento via IA:", iaError.message, iaError.stack);
        // Envia resposta padrão em caso de erro na IA
        const sucesso = await enviarMensagemWhatsApp(
          formattedTelefone,
          "Olá! Tive um problema ao processar sua mensagem com a inteligência artificial. Pode tentar novamente ou usar um comando mais direto (cadastro, financeiro, relatório)?"
        );
         if (!sucesso) {
          console.error("❌ Falha ao enviar mensagem de erro da IA via Z-API.");
          return res.status(500).send({ error: "Erro ao enviar mensagem de erro da IA via Z-API", details: "Falha no Z-API" });
        }
        return res.sendStatus(200); // Retorna 200 pois enviamos uma resposta ao usuário
    }

  } catch (error) {
    // Bloco CATCH GERAL da função receberMensagemWhatsApp
    console.error("❌ ERRO GERAL CAPTURADO na função receberMensagemWhatsApp:", error.message, error.stack);
    
    // Tenta extrair o telefone do remetente MESMO em caso de erro para notificar
    let telefoneErro = null;
    try {
      // Tenta pegar diretamente do body, pois extractMessageAndPhone pode ter falhado
      telefoneErro = req.body?.phone || req.body?.sender || req.body?.from || null;
      if (telefoneErro) {
          let telOriginal = telefoneErro;
          telefoneErro = telefoneErro.replace(/[@c.us|@s.whatsapp.net]/g, "");
          if (!telefoneErro.startsWith("+") && telefoneErro.length >= 10) {
              telefoneErro = "+55" + telefoneErro.replace(/^55/, "");
          }
          console.log(`Telefone para erro recuperado e normalizado de ${telOriginal} para ${telefoneErro}`);
      } else {
          console.error("Não foi possível extrair telefone do remetente do req.body para enviar msg de erro.");
      }
    } catch (extractError) {
      console.error("❌ Erro adicional ao tentar extrair telefone para mensagem de erro geral:", extractError);
    }

    if (telefoneErro) {
      try {
         // !!! GARANTA QUE enviarMensagemWhatsApp ESTEJA DEFINIDA/IMPORTADA !!!
        await enviarMensagemWhatsApp(telefoneErro, "❌ Ocorreu um erro inesperado ao processar sua mensagem. A equipe de suporte foi notificada.");
      } catch (sendError) {
        console.error("❌ Falha CRÍTICA ao tentar enviar mensagem de erro geral para o remetente:", sendError);
      }
    }
    // Retorna erro 500 para a requisição original, indicando falha no servidor
    return res.status(500).send({ error: "Erro interno do servidor", details: error.message });
  }
}

// Exporte a função se este for um módulo (necessário para Cloud Functions)
// Exemplo para Google Cloud Functions (Node.js 18+):
// exports.receberMensagemWhatsApp = receberMensagemWhatsApp;

// Se estiver usando ES Modules (import/export):
// export { receberMensagemWhatsApp };

// ========================================================================
// LEMBRETES IMPORTANTES:
// 1. IMPORTE/DEFINA TODAS AS OUTRAS FUNÇÕES:
//    - enviarMensagemWhatsApp (para Z-API)
//    - classificarMensagem (seu pré-filtro)
//    - cadastrarMembroWhatsApp, processarDizimos, detectarNomeMembro, 
//      registrarTransacaoFinanceira, gerarRelatorio (suas funções de lógica/banco de dados)
//    - Configure o cliente `openai`
//    - Certifique-se que `fetch` está disponível ou importe `node-fetch`
//
// 2. AJUSTE A LÓGICA INTERNA de `extractMessageAndPhone` se os logs mostrarem
//    que os dados não estão sendo extraídos corretamente do `req.body`.
//
// 3. IMPLEMENTE OS BLOCOS DE TRATAMENTO PÓS-IA se quiser que a IA realmente
//    execute as ações de cadastro, financeiro e relatório.
// ========================================================================

// Exportar a função principal
module.exports = { receberMensagemWhatsApp };

console.log("✅ Webhook inicializado e pronto para receber requisições.");