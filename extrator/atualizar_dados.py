"""
Extrai os dados da Ação Copo 15 Anos do SQL Server local, gera data/dados.json
e publica no GitHub (a Vercel faz o deploy automaticamente a cada push).

Uso:
  python atualizar_dados.py                 # período oficial da ação + git push
  python atualizar_dados.py --sem-push      # só gera o JSON
  python atualizar_dados.py --inicio 2026-10-01 --fim 2026-10-08 --saida ../data/teste.json --sem-push
"""
import argparse
import datetime as dt
import json
import logging
import os
import subprocess
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import pyodbc

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent

INICIO_ACAO = '2026-10-15'
FIM_ACAO = '2026-11-30'
LIMITE = 250.00            # comanda precisa ser MAIOR que este valor para ganhar o copo
LIMITE_INCLUI_SERVICO = False  # False = consumo (sem taxa de serviço); True = valor total pago

# ---------------------------------------------------------------------------
# Consultas
#
# Espetto: mesma lógica da vw_faturamento_espetto_cupom, porém a taxa de serviço
# e as cortesias (que são valores por loja/dia) entram só no faturamento do dia,
# e NÃO em cada comanda (na view elas são repetidas em todas as comandas do dia,
# inflando o valor individual).
# ---------------------------------------------------------------------------
SQL_COMANDAS_ESPETTO = """
SELECT l.lojas AS loja,
       CAST(v.dataVenda AS date) AS data,
       v.tipoVenda AS tipo,
       v.controle AS comanda,
       SUM(v.valLiquido) AS liquido,
       SUM(v.valAcrescimo) AS acrescimo
FROM bd_espetto_2025.dbo.bd_vendas_v3 v
JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = v.codLoja
WHERE v.cancelada = 'N' AND v.dataVenda >= ? AND v.dataVenda < ?
GROUP BY l.lojas, CAST(v.dataVenda AS date), v.tipoVenda, v.controle
"""

SQL_AJUSTES_ESPETTO = """
SELECT l.lojas AS loja, CAST(x.dataVenda AS date) AS data,
       SUM(x.servico) AS servico, SUM(x.cortesia) AS cortesia
FROM (
    SELECT codLoja, dataVenda, SUM(valTaxaServico) AS servico, 0 AS cortesia
    FROM bd_espetto_2025.dbo.BD_TC_V2
    WHERE cancelada = 'N' AND dataVenda >= ? AND dataVenda < ?
    GROUP BY codLoja, dataVenda
    UNION ALL
    SELECT codLoja, dataVenda, 0, SUM(valor)
    FROM bd_espetto_2025.dbo.BD_PAGAMENTOS_V2
    WHERE receita IN ('cortesia', 'DUO GORMET') AND cancelada = 'N' AND dataVenda >= ? AND dataVenda < ?
    GROUP BY codLoja, dataVenda
) x
JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = x.codLoja
GROUP BY l.lojas, CAST(x.dataVenda AS date)
"""

SQL_VILLA = """
SELECT LOJA, DATA, PRODUTO, COMANDAS, SUM(QUANTIDADE) AS qtd, SUM(VALOR) AS valor
FROM vw_faturamento_villa_lobos_cupom
WHERE DATA >= ? AND DATA < ?
GROUP BY LOJA, DATA, PRODUTO, COMANDAS
"""

# Cabo Frio Collab (Mané): a view já calcula serviço/cortesia por comanda, então é usada diretamente
SQL_COLLAB = """
SELECT LOJA AS loja, CAST(DATA_HORA AS date) AS data, COMANDA AS comanda, SUM(FATURAMENTO) AS valor
FROM vw_faturamento_cabofrio_collab_cupom
WHERE DATA_HORA >= ? AND DATA_HORA < ?
GROUP BY LOJA, CAST(DATA_HORA AS date), COMANDA
"""

# Produtos da Cabo Frio Collab: mesma lógica da prod_15_anos_espetto, na base do Mané (loja 13)
SQL_PRODUTOS_COLLAB = """
SELECT 'MAN CABO FRIO COLLAB' AS LOJA, CAST(p.dataVenda AS date) AS data, p.descricaoProduto AS PRODUTO,
       SUM(p.quantidade) AS qtd, SUM(p.valTotal) AS valor
FROM bd_mane_2025.dbo.BD_PRODUTOS_V2 p
WHERE p.codLoja = 13 AND p.cancelado = 'N' AND p.quantidade >= 1 AND p.valUnitario > 1
  AND p.dataVenda >= ? AND p.dataVenda < ?
GROUP BY CAST(p.dataVenda AS date), p.descricaoProduto
"""

SQL_PRODUTOS = """
SELECT LOJA, CAST(DATA AS date) AS data, PRODUTO, SUM(QUANTIDADE) AS qtd, SUM(VALOR) AS valor
FROM prod_15_anos_espetto
WHERE DATA >= ? AND DATA < ?
GROUP BY LOJA, CAST(DATA AS date), PRODUTO
"""

# Mesma lógica da prod_15_anos_espetto, sem o filtro fixo de data (usado só em testes antes de 15/10)
SQL_PRODUTOS_BASE = """
SELECT l.lojas AS LOJA, CAST(p.dataVenda AS date) AS data, p.descricaoProduto AS PRODUTO,
       SUM(p.quantidade) AS qtd, SUM(p.valTotal) AS valor
FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2 p
LEFT JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = p.codLoja
WHERE p.cancelado = 'N' AND p.quantidade >= 1 AND p.valUnitario > 1
  AND p.dataVenda >= ? AND p.dataVenda < ?
GROUP BY l.lojas, CAST(p.dataVenda AS date), p.descricaoProduto
"""


# nomes no banco que diferem do código da planilha
ALIASES = {'MAN COLLAB CABO FRIO': 'MAN CABO FRIO COLLAB'}


def norm(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().upper()
    s = ' '.join(s.replace('VILLA', 'VILA').split())
    return ALIASES.get(s, s)


def load_env():
    env = {}
    f = BASE / '.env'
    if f.exists():
        for line in f.read_text(encoding='utf-8').splitlines():
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    env.update({k: v for k, v in os.environ.items() if k.startswith('DB_')})
    return env


def connect(env):
    cs = (f"DRIVER={{{env.get('DB_DRIVER', 'ODBC Driver 17 for SQL Server')}}};"
          f"SERVER={env['DB_SERVER']};DATABASE={env.get('DB_DATABASE', 'master')};"
          f"UID={env['DB_USER']};PWD={env['DB_PASSWORD']}")
    cn = pyodbc.connect(cs, timeout=30)
    cn.timeout = 1800
    return cn


def fetch(cn, sql, params, label):
    t = dt.datetime.now()
    cur = cn.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    logging.info('%s: %d linhas em %.1fs', label, len(rows), (dt.datetime.now() - t).total_seconds())
    return rows


def daterange(a, b):
    d = dt.date.fromisoformat(a)
    end = dt.date.fromisoformat(b)
    while d <= end:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def build(cn, inicio, fim):
    lojas = json.loads((BASE / 'lojas.json').read_text(encoding='utf-8'))
    idx_loja = {norm(l['codigo']): i for i, l in enumerate(lojas)}
    dias = list(daterange(inicio, fim))
    idx_dia = {d: i for i, d in enumerate(dias)}

    # limita a consulta até hoje (não há vendas futuras)
    hoje = dt.date.today()
    fim_q = min(dt.date.fromisoformat(fim), hoje) + dt.timedelta(days=1)
    ini_q = dt.date.fromisoformat(inicio)
    vendas = defaultdict(lambda: [0.0, 0, 0, 0.0])  # (loja, dia) -> fat, comandas, comandas>lim, fat>lim
    produtos = defaultdict(lambda: [0.0, 0.0])     # (loja, dia, produto) -> qtd, valor
    nomes_prod = {}
    sem_mapa = set()

    def loja_i(nome):
        i = idx_loja.get(norm(nome))
        if i is None:
            sem_mapa.add(str(nome))
        return i

    if ini_q < fim_q:
        p = (ini_q, fim_q)

        # ---- Espetto (comandas) ----
        for r in fetch(cn, SQL_COMANDAS_ESPETTO, p, 'comandas espetto'):
            li = loja_i(r.loja)
            d = r.data.isoformat() if hasattr(r.data, 'isoformat') else str(r.data)[:10]
            if li is None or d not in idx_dia:
                continue
            consumo = float(r.liquido or 0) - float(r.acrescimo or 0)
            base = float(r.liquido or 0) if LIMITE_INCLUI_SERVICO else consumo
            v = vendas[(li, idx_dia[d])]
            v[0] += consumo
            v[1] += 1
            if base > LIMITE:
                v[2] += 1
                v[3] += base

        # ---- Espetto (taxa de serviço e cortesias do dia) ----
        for r in fetch(cn, SQL_AJUSTES_ESPETTO, p + p, 'servico/cortesia espetto'):
            li = loja_i(r.loja)
            d = r.data.isoformat()
            if li is None or d not in idx_dia:
                continue
            vendas[(li, idx_dia[d])][0] += float(r.servico or 0) - float(r.cortesia or 0)

        # ---- Villa Lobos (comandas + produtos na mesma query) ----
        com_villa = defaultdict(float)
        for r in fetch(cn, SQL_VILLA, p, 'villa lobos'):
            li = loja_i(r.LOJA)
            d = r.DATA.isoformat()
            if li is None or d not in idx_dia:
                continue
            di = idx_dia[d]
            com_villa[(li, di, r.COMANDAS)] += float(r.valor or 0)
            nome = (r.PRODUTO or '').strip().upper()
            nomes_prod.setdefault(nome, len(nomes_prod))
            pr = produtos[(li, di, nomes_prod[nome])]
            pr[0] += float(r.qtd or 0)
            pr[1] += float(r.valor or 0)
        for (li, di, _), val in com_villa.items():
            v = vendas[(li, di)]
            v[0] += val
            v[1] += 1
            if val > LIMITE:
                v[2] += 1
                v[3] += val

        # ---- Cabo Frio Collab (comandas) ----
        for r in fetch(cn, SQL_COLLAB, p, 'cabo frio collab'):
            li = loja_i(r.loja)
            d = r.data.isoformat()
            if li is None or d not in idx_dia:
                continue
            val = float(r.valor or 0)
            v = vendas[(li, idx_dia[d])]
            v[0] += val
            v[1] += 1
            if val > LIMITE:
                v[2] += 1
                v[3] += val

        # ---- Produtos (Espetto + Cabo Frio Collab) ----
        sql_prod = SQL_PRODUTOS if ini_q >= dt.date.fromisoformat(INICIO_ACAO) else SQL_PRODUTOS_BASE
        linhas_prod = fetch(cn, sql_prod, p, 'produtos espetto') + fetch(cn, SQL_PRODUTOS_COLLAB, p, 'produtos collab')
        for r in linhas_prod:
            li = loja_i(r.LOJA)
            d = r.data.isoformat()
            if li is None or d not in idx_dia:
                continue
            nome = (r.PRODUTO or '').strip().upper()
            nomes_prod.setdefault(nome, len(nomes_prod))
            pr = produtos[(li, idx_dia[d], nomes_prod[nome])]
            pr[0] += float(r.qtd or 0)
            pr[1] += float(r.valor or 0)

    if sem_mapa:
        logging.info('Lojas no banco fora da ação (ignoradas): %s', ', '.join(sorted(sem_mapa)))

    lojas_out = [{k: l[k] for k in ('codigo', 'nome', 'cidade', 'uf', 'endereco', 'copos', 'lat', 'lng')} for l in lojas]
    return {
        'atualizado_em': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
        'periodo': {'inicio': inicio, 'fim': fim},
        'limite': LIMITE,
        'limite_inclui_servico': LIMITE_INCLUI_SERVICO,
        'lojas': lojas_out,
        'dias': dias,
        'vendas': [[li, di, round(v[0], 2), v[1], v[2], round(v[3], 2)]
                   for (li, di), v in sorted(vendas.items()) if v[1] or v[0]],
        'produtos': [n for n, _ in sorted(nomes_prod.items(), key=lambda x: x[1])],
        'prod': [[li, di, pi, round(q, 3), round(val, 2)]
                 for (li, di, pi), (q, val) in sorted(produtos.items()) if q > 0],
    }


def git(*args):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} falhou: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.strip()


def publicar(saida):
    rel = saida.relative_to(ROOT).as_posix()
    git('add', rel)
    if not git('status', '--porcelain', '--', rel):
        logging.info('Sem alterações nos dados; nada a publicar.')
        return
    git('commit', '-m', f'dados: atualização {dt.datetime.now():%d/%m/%Y %H:%M}', '--', rel)
    # o workflow do GitHub (gateway) também grava este arquivo: integra antes de enviar,
    # mantendo a versão local em caso de conflito (as duas são do mesmo horário)
    git('pull', '--rebase', '-X', 'theirs')
    git('push')
    logging.info('Dados publicados no GitHub (a Vercel fará o deploy em instantes).')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--inicio', default=INICIO_ACAO)
    ap.add_argument('--fim', default=FIM_ACAO)
    ap.add_argument('--saida', default=str(ROOT / 'data' / 'dados.json'))
    ap.add_argument('--sem-push', action='store_true')
    a = ap.parse_args()

    (BASE / 'logs').mkdir(exist_ok=True)
    logging.basicConfig(
        level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s',
        handlers=[logging.FileHandler(BASE / 'logs' / 'atualizacao.log', encoding='utf-8'),
                  logging.StreamHandler(sys.stdout)])
    try:
        logging.info('Iniciando extração %s a %s', a.inicio, a.fim)
        cn = connect(load_env())
        data = build(cn, a.inicio, a.fim)
        cn.close()
        saida = Path(a.saida).resolve()
        saida.parent.mkdir(parents=True, exist_ok=True)
        saida.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        logging.info('Arquivo gerado: %s (%d vendas, %d linhas de produto, %.0f KB)',
                     saida, len(data['vendas']), len(data['prod']), saida.stat().st_size / 1024)
        if not a.sem_push:
            publicar(saida)
    except Exception:
        logging.exception('Falha na atualização')
        sys.exit(1)


if __name__ == '__main__':
    main()
