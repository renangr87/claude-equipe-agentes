// Mostra a entrada de um servidor MCP já registrado na configuração do usuário
// (.claude.json), em JSON numa linha. Não mostra nada se não existir ou se o arquivo
// não puder ser lido. Feito em Node pelo mesmo motivo do registrar-mcp.mjs: o
// .claude.json pode ser grande demais para o Windows PowerShell 5.1.
//
// Uso: node ler-mcp.mjs <arquivo .claude.json> <nome>
//
// Caracteres fora do ASCII saem como \uXXXX, para não depender da página de código
// do console do Windows (caminho com acento).
import fs from 'node:fs';

const [arquivo, nome] = process.argv.slice(2);
try {
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const entrada = dados?.mcpServers?.[nome];
  if (entrada && typeof entrada === 'object') {
    const texto = JSON.stringify(entrada).replace(/[\u007f-￿]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    process.stdout.write(texto + '\n');
  }
} catch {
  // Arquivo ausente ou inválido: nada a mostrar.
}
