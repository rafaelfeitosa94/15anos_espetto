"""
Gera data/ano_anterior.json (15/10/2025 a 30/11/2025) a partir das views *_ano_anterior,
no mesmo formato de data/dados.json. Os dados de 2025 não mudam: basta rodar uma vez.

  python extrator/gerar_ano_anterior.py

Regra do copo (igual ao ano atual): comanda com VALOR_CONSUMO (sem taxa de serviço) maior que R$ 250.
Faturamento: soma da coluna FATURAMENTO das views (consumo + serviço - cortesia por comanda).
"""
import datetime as dt
import json
import logging
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atualizar_dados import BASE, ROOT, LIMITE, connect, daterange, fetch, load_env, norm  # noqa: E402

INICIO, FIM = '2025-10-15', '2025-11-30'

SQL_COMANDAS = """
SELECT LOJA AS loja, CAST(DATA_HORA AS date) AS data, COMANDA AS comanda,
       SUM(FATURAMENTO) AS fat, SUM(VALOR_CONSUMO) AS consumo
FROM {view}
GROUP BY LOJA, CAST(DATA_HORA AS date), COMANDA, [TIPO VENDA]
"""
SQL_PRODUTOS = """
SELECT LOJA AS loja, CAST(DATA AS date) AS data, PRODUTO AS produto,
       SUM(QUANTIDADE) AS qtd, SUM(VALOR) AS valor
FROM {view}
GROUP BY LOJA, CAST(DATA AS date), PRODUTO
"""


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    lojas = json.loads((BASE / 'lojas.json').read_text(encoding='utf-8'))
    idx_loja = {norm(l['codigo']): i for i, l in enumerate(lojas)}
    dias = list(daterange(INICIO, FIM))
    idx_dia = {d: i for i, d in enumerate(dias)}
    vendas = defaultdict(lambda: [0.0, 0, 0, 0.0])
    produtos = defaultdict(lambda: [0.0, 0.0])
    nomes = {}
    fora = set()

    cn = connect(load_env())
    for view in ('vw_faturamento_espetto_cupom_ano_anterior', 'vw_faturamento_cabofrio_collab_cupom_ano_anterior'):
        for r in fetch(cn, SQL_COMANDAS.format(view=view), (), view):
            li = idx_loja.get(norm(r.loja))
            d = r.data.isoformat()
            if li is None:
                fora.add(r.loja)
                continue
            if d not in idx_dia:
                continue
            consumo = round(float(r.consumo or 0), 2)
            v = vendas[(li, idx_dia[d])]
            v[0] += float(r.fat or 0)
            v[1] += 1
            if consumo > LIMITE:
                v[2] += 1
                v[3] += consumo
    for view in ('prod_15_anos_espetto_ano_anterior', 'prod_15_anos_cabofrio_collab_ano_anterior'):
        for r in fetch(cn, SQL_PRODUTOS.format(view=view), (), view):
            li = idx_loja.get(norm(r.loja))
            d = r.data.isoformat()
            if li is None or d not in idx_dia or not (r.qtd or 0) > 0:
                continue
            nome = (r.produto or '').strip().upper()
            nomes.setdefault(nome, len(nomes))
            p = produtos[(li, idx_dia[d], nomes[nome])]
            p[0] += float(r.qtd or 0)
            p[1] += float(r.valor or 0)
    cn.close()
    if fora:
        logging.info('Lojas fora da ação (ignoradas): %s', ', '.join(sorted(str(x) for x in fora)))

    dados = {
        'gerado_em': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
        'periodo': {'inicio': INICIO, 'fim': FIM},
        'limite': LIMITE,
        'fonte': 'views *_ano_anterior',
        'dias': dias,
        'vendas': [[li, di, round(v[0], 2), v[1], v[2], round(v[3], 2)] for (li, di), v in sorted(vendas.items()) if v[1]],
        'produtos': [n for n, _ in sorted(nomes.items(), key=lambda x: x[1])],
        'prod': [[li, di, pi, round(q, 3), round(val, 2)] for (li, di, pi), (q, val) in sorted(produtos.items())],
    }
    saida = ROOT / 'data' / 'ano_anterior.json'
    saida.write_text(json.dumps(dados, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    lojas_com_dados = sorted({lojas[li]['nome'] for li, _ in vendas})
    sem = [l['nome'] for l in lojas if l['nome'] not in lojas_com_dados]
    logging.info('Gerado %s: %d linhas de vendas, %d de produtos, %.0f KB', saida, len(dados['vendas']),
                 len(dados['prod']), saida.stat().st_size / 1024)
    logging.info('Lojas sem dados no ano anterior: %s', ', '.join(sem) or '(nenhuma)')


if __name__ == '__main__':
    main()
