# Checklist de fumée — à rejouer avant chaque mise en production

Prérequis : deux serveurs de test (`ÉMETTEUR`, `RÉCEPTEUR`), le bot invité sur les deux.

1. `/network invite` sur ÉMETTEUR (compte owner) → un code est renvoyé en éphémère.
2. `/set-lfg-channel` avec ce code sur ÉMETTEUR → confirmation d'entrée dans le réseau.
3. Répéter 1-2 sur RÉCEPTEUR avec un second code.
4. Retirer au bot la permission « Envoyer des messages » sur le salon LFG de RÉCEPTEUR, puis `/set-lfg-channel` → le bot annonce la permission manquante. Rétablir.
5. `/recruit` sur ÉMETTEUR avec un membre **sans** le rôle recruteur → refus explicite.
6. `/recruit` avec le rôle recruteur → le constructeur de roster s'affiche en éphémère.
7. Ajouter deux places (dont deux fois la même spé), en retirer une, redémarrer le bot, rouvrir le message → l'état du brouillon est conservé.
8. `[Publish LFG]` → l'annonce apparaît sur les deux serveurs, le dashboard arrive en DM.
9. Fermer ses DM et republier une annonce → le dashboard bascule sur un thread privé.
10. Cliquer `[⚔️ Apply]` avec une seule place ouverte → le modal s'ouvre directement.
11. Soumettre un iLvl non numérique et un lien hors warcraftlogs → les deux erreurs sont listées ensemble.
12. Soumettre une candidature valide → confirmation, et le dashboard se met à jour en quelques secondes.
13. Avec deux places ouvertes, cliquer `[⚔️ Apply]` → le select de rôle précède le modal.
14. Accepter un candidat → DM reçu par le joueur, place `✅ Filled` sur **les deux** serveurs.
15. Accepter la dernière place → titre `[COMPLETED]` et bouton `Apply` désactivé partout.
16. Supprimer manuellement le message public sur RÉCEPTEUR puis provoquer une mise à jour → aucune republication, aucune boucle d'erreur dans les logs.
17. Expulser le bot de RÉCEPTEUR → `/network status` le montre suspendu, plus aucune émission vers lui.
18. Créer une annonce à une heure déjà dépassée dans la minute → passage automatique en `[EXPIRED]`.
