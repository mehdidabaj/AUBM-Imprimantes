# AUBM — Parc imprimantes

Application web pour suivre le parc d'imprimantes à partir du relevé du **4 juin 2025** : identité, adresse, niveaux de toner, kits et observations.

## Lancer

Depuis la racine du dépôt :

```bash
python3 -m http.server 4173
```

Puis ouvrir [http://127.0.0.1:4173](http://127.0.0.1:4173).

Les modifications (niveaux, ajouts, interventions) restent dans le navigateur (`localStorage`). Le bouton de restauration du journal remet le relevé d'origine.

## Ce que l'on peut faire

- Voir les machines à traiter (observation autre que RAS, ou consommable à 10 % ou moins) et celles à surveiller (jusqu'à 30 %).
- Filtrer le parc par département, état, couleur, réseau ou antenne.
- Ouvrir une fiche, corriger les niveaux et enregistrer un remplacement.
- Exporter le parc en CSV (la liste filtrée, si un filtre est actif sur l'inventaire).

Le traceur HP T930 est suivi sur ses six encres (noir photo, gris, noir mat, cyan, magenta, jaune). Pour le bureau Régisseur, le texte du relevé et les colonnes de pourcentages du tableau ne coïncident pas : la fiche le signale et retient les pourcentages des colonnes.
