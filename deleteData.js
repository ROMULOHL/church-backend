const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, deleteDoc, doc } = require('firebase/firestore');

const firebaseConfig = {
    apiKey: "AIzaSyC06jYlz3XH6C6h51-qSt7LZm4ahb7AR04",
    authDomain: "churchgpt-e629d.firebaseapp.com",
    projectId: "churchgpt-e629d",
    storageBucket: "churchgpt-e629d.firebasestorage.app",
    messagingSenderId: "697470128115",
    appId: "1:697470128115:web:f9f8bbf4b7d11d35450c86"
  };

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function deleteAllDocs(collectionName) {
  const querySnapshot = await getDocs(collection(db, collectionName));
  for (const docSnapshot of querySnapshot.docs) {
    await deleteDoc(doc(db, collectionName, docSnapshot.id));
    console.log(`Excluído documento ${docSnapshot.id} da coleção ${collectionName}`);
  }
}

async function main() {
  const collections = ['membros', 'transacoes', 'dizimosPendentes', 'entrada', 'saida'];
  for (const collectionName of collections) {
    console.log(`Limpando coleção: ${collectionName}`);
    await deleteAllDocs(collectionName);
  }
  console.log('Todas as coleções foram limpas!');
}

main().catch(err => console.error(err));