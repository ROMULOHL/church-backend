const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
require('dotenv').config();

// Inicializar o Firebase Admin
console.log('Inicializando Firebase Admin...');
if (!admin.apps.length) {
  try {
    admin.initializeApp();
    console.log('Firebase Admin inicializado com sucesso.');
  } catch (error) {
    console.error('Erro ao inicializar Firebase Admin:', error);
    throw error;
  }
}

const webhook = require('./webhook');

// Configuração de execução
const runtimeOpts = {
  timeoutSeconds: 60,
  memory: '128MB',
  region: 'us-central1',
};

// Função para receber mensagens do WhatsApp
exports.receberMensagemWhatsApp = onRequest(runtimeOpts, (req, res) => {
  // Health check endpoint
  if (req.path === '/health') {
    console.log('Health check solicitado.');
    return res.status(200).send('OK');
  }

  console.log('Função receberMensagemWhatsApp iniciada.');
  console.log('Método da requisição:', req.method);
  console.log('Caminho da requisição:', req.path);
  console.log('Corpo da requisição:', JSON.stringify(req.body));
  return webhook.receberMensagemWhatsApp(req, res);
});