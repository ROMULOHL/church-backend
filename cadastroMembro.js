const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: "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"
});

exports.cadastrarMembroWhatsApp = async (mensagem, telefone) => {
  try {
    const respostaIA = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `Você é um extrator de dados de mensagens do WhatsApp para cadastro de membros de igreja.

⚠️ REGRAS:
- Extraia APENAS os dados explicitamente presentes no texto.  
- Se um dado não estiver presente, retorne o campo vazio ("", 0, false).  
- Nunca preencha com valores genéricos ou inventados.

Mensagem original: o usuário pode escrever de forma natural, como "Cadastro da irmã Ana, 45 anos, batizada, líder, casada".

Seu objetivo é preencher este JSON:

{
  "nome": "string",
  "telefone": "string",
  "idade": 0,
  "funcao": "string",
  "profissao": "string",
  "estado_civil": "string",
  "dizimista": false,
  "batizado": false,
  "cursos": {
    "EncontroComDeus": false,
    "CursoDeBatismo": false,
    "MaturidadeNoEspírito": false,
    "EscolaDeLideres": false,
    "Outros": ""
  }
}

⚠️ IMPORTANTE: retorne SOMENTE o JSON, sem explicações.`

        },
        {
          role: "user",
          content: mensagem
        }
      ]
    });

    // 🛡️ Parse seguro da resposta da IA
    let dados;
    try {
      const respostaLimpa = respostaIA.choices[0].message.content.trim();
      const matchJson = respostaLimpa.match(/{[\s\S]*}/);
      if (!matchJson) throw new Error("Formato de resposta inválido da IA.");
      dados = JSON.parse(matchJson[0]);
    } catch (e) {
      console.error("❌ Erro ao interpretar resposta da IA:", e.message);
      return "⚠️ Não consegui extrair os dados corretamente. Verifique a mensagem e tente novamente.";
    }

    // ✅ Garantir preenchimento dos campos
    dados.nome = dados.nome || "";
    dados.telefone = typeof dados.telefone === "string" && dados.telefone.trim().length > 0 ? dados.telefone : "";
    dados.idade = dados.idade || 0;
    dados.funcao = dados.funcao || "";
    dados.profissao = dados.profissao || "";
    dados.estado_civil = dados.estado_civil || "";
    dados.dizimista = !!dados.dizimista;
    dados.batizado = !!dados.batizado;

    dados.cursos = {
      EncontroComDeus: !!dados.cursos?.EncontroComDeus,
      CursoDeBatismo: !!dados.cursos?.CursoDeBatismo,
      MaturidadeNoEspírito: !!dados.cursos?.MaturidadeNoEspírito,
      EscolaDeLideres: !!dados.cursos?.EscolaDeLideres,
      Outros: dados.cursos?.Outros || ""
    };

    dados.dataCadastro = new Date().toISOString();

    // 💾 Salvar no Firestore
    await db.collection("membros").add(dados);

    // 📨 Mensagem formatada para retorno via WhatsApp
    return `🙌 Membro cadastrado com sucesso!

📋 Nome: ${dados.nome}
📱 Telefone: ${dados.telefone}
📆 Idade: ${dados.idade}
🧑‍💼 Função: ${dados.funcao}
🧑‍💼 Profissão: ${dados.profissao}
💍 Estado Civil: ${dados.estado_civil}
💸 Dizimista: ${dados.dizimista ? "✅" : "❌"}
💧 Batizado: ${dados.batizado ? "✅" : "❌"}
📚 Cursos:
• Encontro com Deus: ${dados.cursos.EncontroComDeus ? "✅" : "❌"}
• Curso de Batismo: ${dados.cursos.CursoDeBatismo ? "✅" : "❌"}
• Maturidade no Espírito: ${dados.cursos.MaturidadeNoEspírito ? "✅" : "❌"}
• Escola de Líderes: ${dados.cursos.EscolaDeLideres ? "✅" : "❌"}
• Outros: ${dados.cursos.Outros || "Nenhum"}

🗂️ Já está salvo no sistema!`;

  } catch (error) {
    console.error("❌ Erro ao cadastrar membro:", error);
    return "⚠️ Erro ao cadastrar membro. Verifique se todas as informações foram enviadas corretamente.";
  }
};
