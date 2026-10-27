"""
Complementa data/ano_anterior.json com lojas que em 2025 ainda não estavam no Degust e só existem na
tabela diária antiga bd_espetto.dbo.[BD VENDAS] (faturamento e clientes por dia, sem comandas nem produtos).

  python extrator/complementar_ano_anterior.py

Hoje:
  ESP GRANDE RIO        15/10 a 09/11/2025 na BD VENDAS; de 10/11 a 10/12/2025 não aparece em nenhuma base
                        (entrou no Degust em 11/12/2025).
  ESP CAXIAS CARREFOUR  15/10 a 05/11/2025 na BD VENDAS; a partir de 06/11/2025 já vem do Degust (com comandas).
Só entram os dias em que a loja ainda não tem dados do Degust.
Faturamento = [Faturamento Bruto] - DELIVERY, como na query de referência da BD VENDAS.
As linhas entram com comandas = 0 e a loja fica listada em "so_faturamento". No dashboard, a loja é comparada
com 2026 só nas mesmas datas: o faturamento nos dias com dado em 2025, e comandas, ticket médio e > R$ 250
só nos dias com comandas em 2025 (Degust).
Pode rodar mais de uma vez: as linhas da BD VENDAS (comandas = 0) dessas lojas são substituídas.

Também acrescenta a Península (PDV próprio, bd_peninsula_frest.dbo.BD_VENDAS, com comandas): faturamento e
consumo da comanda = TOT_CUPON (mesma regra de 2026), comandas > R$ 250 por TOT_CUPON. Sem produtos em 2025.
"""
import datetime as dt
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atualizar_dados import BASE, ROOT, connect, fetch, load_env, norm  # noqa: E402

LOJAS = ['ESP GRANDE RIO', 'ESP CAXIAS CARREFOUR']
FONTE = 'bd_espetto.dbo.[BD VENDAS] (faturamento diário, sem comandas)'

SQL = """
SELECT P.LOJA AS loja, CAST(P.DATA AS date) AS data,
       SUM(P.[Faturamento Bruto] - P.DELIVERY) AS fat, SUM(P.[TOTAL CLIENTES]) AS tc
FROM bd_espetto.dbo.[BD VENDAS] P
WHERE P.DATA >= ? AND P.DATA <= ? AND P.LOJA IN ({marcas})
GROUP BY P.LOJA, CAST(P.DATA AS date)
"""


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    arq = ROOT / 'data' / 'ano_anterior.json'
    aa = json.loads(arq.read_text(encoding='utf-8'))
    lojas = json.loads((BASE / 'lojas.json').read_text(encoding='utf-8'))
    idx_loja = {norm(l['codigo']): i for i, l in enumerate(lojas)}
    idx_dia = {d: i for i, d in enumerate(aa['dias'])}
    alvo = {idx_loja[norm(c)]: c for c in LOJAS}

    cn = connect(load_env())
    sql = SQL.format(marcas=', '.join('?' * len(LOJAS)))
    linhas = fetch(cn, sql, (aa['periodo']['inicio'], aa['periodo']['fim'], *LOJAS), 'BD VENDAS')
    cn.close()

    # mantém o que veio do Degust (comandas > 0); remove só o que este script acrescentou antes
    aa['vendas'] = [v for v in aa['vendas'] if not (v[0] in alvo and v[3] == 0)]
    com_degust = {(v[0], v[1]) for v in aa['vendas']}
    novas, info = [], {}
    for r in linhas:
        li = idx_loja.get(norm(r.loja))
        d = r.data.isoformat()
        if li not in alvo or d not in idx_dia or not r.fat or (li, idx_dia[d]) in com_degust:
            continue
        novas.append([li, idx_dia[d], round(float(r.fat), 2), 0, 0, 0])
        i = info.setdefault(lojas[li]['codigo'], {'fonte': FONTE, 'de': d, 'ate': d, 'clientes': 0})
        i['de'], i['ate'] = min(i['de'], d), max(i['ate'], d)
        i['clientes'] += int(r.tc or 0)

    aa['vendas'] = sorted(aa['vendas'] + novas, key=lambda v: (v[0], v[1]))
    aa['so_faturamento'] = info
    aa['complementado_em'] = dt.datetime.now().astimezone().isoformat(timespec='seconds')
    arq.write_text(json.dumps(aa, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    for cod, i in info.items():
        fat = sum(v[2] for v in novas if lojas[v[0]]['codigo'] == cod)
        logging.info('%s: %s a %s, R$ %.2f, %d clientes', cod, i['de'], i['ate'], fat, i['clientes'])
    sem = [c for c in LOJAS if c not in info]
    if sem:
        logging.warning('Sem dados na BD VENDAS: %s', ', '.join(sem))
    peninsula(arq, lojas, idx_loja)


SQL_PEN = """
SELECT d AS data, COUNT(*) AS com, SUM(v) AS fat,
       SUM(CASE WHEN v > 250 THEN 1 ELSE 0 END) AS c250, SUM(CASE WHEN v > 250 THEN v ELSE 0 END) AS f250
FROM (SELECT TRY_CONVERT(date, DATA, 103) AS d, NUM_LANCTO, ROUND(SUM(TOT_CUPON), 2) AS v
      FROM bd_peninsula_frest.dbo.BD_VENDAS
      WHERE TRY_CONVERT(date, DATA, 103) >= ? AND TRY_CONVERT(date, DATA, 103) <= ?
      GROUP BY TRY_CONVERT(date, DATA, 103), NUM_LANCTO) x
GROUP BY d
"""


def peninsula(arq, lojas, idx_loja):
    aa = json.loads(arq.read_text(encoding='utf-8'))
    li = idx_loja[norm('ESP PENÍNSULA')]
    idx_dia = {d: i for i, d in enumerate(aa['dias'])}
    cn = connect(load_env())
    linhas = fetch(cn, SQL_PEN, (aa['periodo']['inicio'], aa['periodo']['fim']), 'Península BD_VENDAS')
    cn.close()
    novas = [[li, idx_dia[r.data.isoformat()], round(float(r.fat), 2), int(r.com), int(r.c250), round(float(r.f250), 2)]
             for r in linhas if r.data and r.data.isoformat() in idx_dia and r.com]
    aa['vendas'] = sorted([v for v in aa['vendas'] if v[0] != li] + novas, key=lambda v: (v[0], v[1]))
    arq.write_text(json.dumps(aa, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    logging.info('ESP PENÍNSULA 2025: %d dias, R$ %.2f, %d comandas, %d > R$ 250', len(novas),
                 sum(v[2] for v in novas), sum(v[3] for v in novas), sum(v[4] for v in novas))


if __name__ == '__main__':
    main()
