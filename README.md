# BROKE!

Jeu local dans `index.html`, salons privés à 2–4 joueurs dans `salon.html`.

## Jouer sur téléphone

La version publiée est disponible sur
https://adaihaine.github.io/broke-game/salon.html?v=20261123-3
et fonctionne sur des réseaux différents.

Le plateau utilise le flux Firestore avec réponses courtes pour les réseaux mobiles.
Une lecture directe toutes les deux secondes au premier plan récupère les mises à jour
si le flux est suspendu ou retardé. Les actions sont écrites avec une précondition sur
la version du document, et leur confirmation met immédiatement l'écran à jour.
Une réponse perdue est vérifiée par identifiant avant toute nouvelle tentative.
Les cellules du plateau sont conservées entre les tours pour éviter les reconstructions
et les couches 3D du dé ont été remplacées dans le mode en ligne.

## Tester sur le Wi-Fi local

Depuis ce dossier, lancer `python3 serve.py`, puis ouvrir
`http://ADRESSE_WIFI_DU_MAC:8766/salon.html` sur chaque téléphone du même Wi-Fi.
Le Mac doit rester allumé. Le serveur distribue uniquement les fichiers publics du jeu.
Les navigateurs doivent pouvoir accéder à Firebase sur Internet.

Chaque joueur utilise son propre navigateur et son pseudo. Tous se déclarent prêts,
puis l'hôte démarre. Le bandeau du plateau indique l'identité de l'appareil et
le joueur attendu. Les décisions de rachat et d'échange se prennent sur le téléphone
du propriétaire concerné. Une page rechargée reprend la décision enregistrée.

## Code et vérification

- `online-board.js` définit les 32 cases.
- `online-engine.js` applique les actions à un état sérialisable.
- `online.js` affiche cet état et enregistre chaque action dans une transaction Firestore.
- `online-game.html` fournit le plateau et le style du jeu.
- `firestore.rules` contrôle l'appartenance au salon, le décideur, les révisions et la structure des états.

Avec Node.js, `npm test` exécute les tests du moteur, dont 60 parties simulées
à 2, 3 et 4 joueurs. `npm run test:firebase` crée des comptes anonymes et des salons
de test dans le projet configuré, puis vérifie les offres, les abandons,
les refus d'actions du mauvais joueur et les écritures concurrentes.

Les règles ont été publiées le 18 novembre 2026 sur `broke-game-169a7`.
Pour une modification ultérieure, utiliser la console Firebase ou
`firebase deploy --only firestore:rules --project broke-game-169a7`.

Le calcul des règles du jeu et des tirages s'exécute dans le navigateur.
La base contrôle l'accès et la concurrence, mais ne recalcule pas chaque action.
