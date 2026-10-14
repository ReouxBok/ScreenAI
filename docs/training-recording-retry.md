# Reprise de confirmation des vidéos Studio

La finalisation locale distingue désormais le résultat obtenu du stockage et sa confirmation par le Studio. Quand l’upload a répondu avec succès mais que `/api/training/sessions/recording-confirm` échoue, une nouvelle tentative réutilise ce résultat : elle ne renvoie pas le fichier et ne termine pas une deuxième fois le multipart.

Les appels simultanés partagent la même promesse. Le succès final est conservé ; un échec libère seulement la promesse pour permettre une nouvelle tentative explicite. Si le stockage lui-même n’a pas retourné de résultat, cette garantie ne s’applique pas : le code ne prétend pas savoir si un effet distant s’est produit avant la perte de réponse.

Pour le multipart progressif, l’état appartient à son instance. Pour l’upload simple, il est associé au Blob par WeakMap et lié au token de démonstration et à la session ; un autre token ou une autre session ne réutilise pas ce résultat. Aucun secret ou état supplémentaire n’est écrit dans le stockage Chrome ou les logs.

Cette reprise reste en mémoire dans le panneau ouvert. Elle ne permet pas de récupérer une vidéo après fermeture/rechargement du panneau et ne remplace pas une reprise durable côté serveur.

Les tests unitaires reproduisent une confirmation HTTP 503, une erreur réseau et deux appels concurrents dans les deux chemins ; ils vérifient aussi l’isolation session/token et la reprise explicite après échec du stockage multipart. Les appels SDK Blob et HTTP sont simulés. L’enregistrement OS, le stockage distant et le parcours complet OAuth/vidéo restent à qualifier.

Le test navigateur `tests/e2e/training-real-media.spec.js` utilise le recorder empaqueté et le SDK Blob réels. Chromium encode une vidéo canvas et son microphone de test en WebM : les octets envoyés sont décodables en 320 × 180. Après une confirmation 503, la reprise envoie seulement une seconde confirmation identique ; création, transfert de partie et finalisation du stockage restent uniques. Les pistes audio/vidéo sont arrêtées et un nouvel appel après succès conserve le résultat.

Ce test vise le paquet production et intercepte les réponses HTTP Studio/Blob. Il ne vérifie ni le sélecteur système, ni un microphone physique, ni un stockage distant, ni le parcours OAuth complet. Il complète les tests unitaires sans remplacer la recette complète d’entraînement. Commande : `npx playwright test tests/e2e/training-real-media.spec.js`.
