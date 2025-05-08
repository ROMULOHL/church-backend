const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

// Exportar a função diretamente com o mesmo nome
exports.atualizarCursosMembros = async (req, res) => {
  try {
    const membrosRef = db.collection("membros");
    const snapshot = await membrosRef.get();

    if (snapshot.empty) {
      return res.status(200).json({ message: "Nenhum membro encontrado para atualizar." });
    }

    const batch = db.batch();
    snapshot.forEach((doc) => {
      const data = doc.data();
      const cursosAtualizados = {
        EncontroComDeus: !!data.cursos?.EncontroComDeus,
        CursoDeBatismo: !!data.cursos?.CursoDeBatismo,
        MaturidadeNoEspírito: !!data.cursos?.MaturidadeNoEspírito,
        EscolaDeLideres: !!data.cursos?.EscolaDeLideres,
        Outros: data.cursos?.Outros || "",
      };

      batch.update(doc.ref, { cursos: cursosAtualizados });
    });

    await batch.commit();
    return res.status(200).json({ message: "Cursos dos membros atualizados com sucesso!" });
  } catch (error) {
    console.error("Erro ao atualizar cursos dos membros:", error);
    return res.status(500).json({ error: "Erro ao atualizar cursos dos membros." });
  }
};