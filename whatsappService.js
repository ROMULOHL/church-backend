const fetch = require('node-fetch');

// Função para normalizar telefone para o formato +55 DDD 9 XXXX-XXXX (REVISADA)
function normalizarTelefoneBrasil(numero) {
  if (!numero) {
    console.log("📞 normalizarTelefoneBrasil: Número fornecido é nulo ou vazio.");
    return null;
  }
  console.log(`📞 normalizarTelefoneBrasil: Tentando normalizar telefone: "${numero}"`);
  let num = numero.replace(/\D/g, ""); // Remove tudo que não for dígito

  // Caso 1: Já está no formato internacional completo +55DDDNNNNNNNNN (14 caracteres)
  if (numero.startsWith("+") && num.startsWith("55") && num.length === 13) {
    const ddd = num.substring(2, 4);
    const numeroSemDDIeDDD = num.substring(4);
    if (numeroSemDDIeDDD.length === 9 && numeroSemDDIeDDD.startsWith("9")) { // Celular com 9
        console.log(`   ✅ Telefone já estava no formato internacional correto: +${num}`);
        return `+${num}`;
    }
  }

  // Remove 55 do início se houver, para tratar o número base (DDD + numero)
  if (num.startsWith("55") && (num.length === 12 || num.length === 13 || num.length === 11 || num.length === 10)) { // 55 + (10 ou 11 ou 8 ou 9)
    num = num.substring(2);
    console.log(`   Removido DDI 55 inicial, ficou: "${num}"`);
  }

  // Agora 'num' deve ser DDD + número (10 ou 11 dígitos para celular, 8 ou 9 para fixo/celular sem DDD)
  if (num.length === 11) { // Formato DDD (2) + 9 (1) + NNNNNNNN (8)
    const ddd = num.substring(0, 2);
    const restante = num.substring(2);
    if (restante.length === 9 && restante.startsWith("9")) {
      console.log(`   Número de 11 dígitos com DDD e 9 já presente: "${num}". Formatando para +55.`);
      return `+55${num}`;
    } else {
      console.log(`   ❌ Número de 11 dígitos em formato inesperado (esperado DDD + 9XXXXXXXX): "${num}".`);
      return null; 
    }
  } else if (num.length === 10) { // Formato DDD (2) + NNNNNNNN (8) - celular antigo ou fixo
    const ddd = num.substring(0, 2);
    const numeroSemDDD = num.substring(2);
    // Assumindo que números de 10 dígitos (DDD+8) são celulares que precisam do '9'
    console.log(`   Número de 10 dígitos (DDD+8). Adicionando '9' após DDD: ${ddd} -> ${ddd}9${numeroSemDDD}`);
    const numeroCom9 = `${ddd}9${numeroSemDDD}`;
    return `+55${numeroCom9}`;
  } else {
    console.log(`   ❌ Número de telefone com comprimento inesperado após limpeza: "${num}" (comprimento ${num.length}). Esperado 10 ou 11 dígitos (DDD+Num).`);
    return null;
  }
}

async function enviarMensagemWhatsApp(telefone, mensagem) {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN;
  const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;

  // Verificar se as credenciais estão configuradas
  if (!instanceId || !clientToken || !instanceToken) {
    console.error('❌ Credenciais do Z-API não configuradas. Variáveis de ambiente ausentes:');
    console.error(`ZAPI_INSTANCE_ID: ${instanceId || 'não configurado'}`);
    console.error(`ZAPI_CLIENT_TOKEN: ${clientToken ? 'configurado' : 'não configurado'}`);
    console.error(`ZAPI_INSTANCE_TOKEN: ${instanceToken ? 'configurado' : 'não configurado'}`);
    return false;
  }

  const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-text`;
  
  const telefoneNormalizado = normalizarTelefoneBrasil(telefone);
  if (!telefoneNormalizado) {
    console.error('❌ Telefone inválido após normalização:', telefone);
    return false;
  }

  const dados = {
    phone: telefoneNormalizado,
    message: mensagem,
  };

  try {
    console.log('📤 Enviando mensagem via Z-API:', { url, telefone: telefoneNormalizado, mensagem });
    const resposta = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': clientToken,
      },
      body: JSON.stringify(dados),
    });

    const resultado = await resposta.json();
    console.log('📩 Resposta do Z-API:', JSON.stringify(resultado, null, 2));

    if (!resposta.ok) {
      if (resposta.status === 401) {
        console.error('❌ Erro 401: Credenciais inválidas. Verifique ZAPI_CLIENT_TOKEN e ZAPI_INSTANCE_TOKEN.');
      } else if (resposta.status === 400) {
        console.error('❌ Erro 400: Requisição inválida. Detalhes:', resultado);
        console.error(`Telefone enviado: ${telefoneNormalizado}`);
      } else {
        console.error(`❌ Erro ${resposta.status}:`, resultado);
      }
      return false;
    }

    console.log('✅ Mensagem enviada com sucesso via Z-API para:', telefoneNormalizado);
    return true;
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem via Z-API:', error.message);
    return false;
  }
}

module.exports = {
  enviarMensagemWhatsApp,
  normalizarTelefoneBrasil // Adicione esta linha
};
